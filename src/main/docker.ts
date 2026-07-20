import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import type { Project } from '@shared/types'
import {
  IMAGE_VERSION,
  SLIM_IMAGE,
  FULL_IMAGE,
  CREDS_VOLUME,
  HOME_VOLUME,
  BACKEND_PORTS,
  slimDockerfile,
  fullDockerfile
} from './dockerfiles'
import { bridgeDir, ensureBridgeFiles } from './bridge'

export type LineSink = (chunk: string) => void

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** short 4-byte SHA1 hex of a string (ref: 8-char hash suffix in claude-box.ps1). */
function shortHash(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 8)
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

export class DockerService {
  /** Resolved container-runtime binary, or null if none found. */
  private binary: string | null | undefined
  /** Cached Windows host IP the container forwards backend ports to. */
  private hostIp: string | null | undefined
  /** Shared output folder (absolute host path) mounted into every container. */
  private sharedOutput: string | undefined

  /** Set/clear the shared output folder mounted into all containers. */
  setSharedOutput(p: string | undefined): void {
    this.sharedOutput = p || undefined
  }

  // ---- runtime detection (ref 72-81, nerdctl dropped) --------------------
  async detect(): Promise<string | null> {
    if (this.binary !== undefined) return this.binary
    this.binary = (await this.which('docker')) ? 'docker' : null
    return this.binary
  }

  private which(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      // `docker --version` is a cheap existence probe that works cross-platform.
      execFile(cmd, ['--version'], { windowsHide: true }, (err) => resolve(!err))
    })
  }

  private async docker(): Promise<string> {
    const bin = await this.detect()
    if (!bin) throw new Error('docker-missing')
    return bin
  }

  // ---- generic command runners -------------------------------------------
  private async exec(args: string[]): Promise<ExecResult> {
    const bin = await this.docker()
    return new Promise((resolve) => {
      const child = spawn(bin, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
      child.on('error', () => resolve({ code: 1, stdout, stderr: stderr || 'spawn failed' }))
    })
  }

  /** Run a docker command, streaming combined output to a sink line-by-line. */
  private execStream(args: string[], sink: LineSink, stdin?: string): Promise<number> {
    return new Promise(async (resolve) => {
      const bin = await this.docker()
      const child = spawn(bin, args, { windowsHide: true })
      const forward = (d: Buffer): void => sink(d.toString().replace(/\n/g, '\r\n'))
      child.stdout.on('data', forward)
      child.stderr.on('data', forward)
      child.on('close', (code) => resolve(code ?? 0))
      child.on('error', (e) => {
        sink(`\r\n[vivarium] failed to run docker: ${e.message}\r\n`)
        resolve(1)
      })
      if (stdin !== undefined) {
        child.stdin.write(stdin)
        child.stdin.end()
      }
    })
  }

  // ---- Windows host IP (ref 229-250) -------------------------------------
  private async detectHostIp(): Promise<string | null> {
    if (this.hostIp !== undefined) return this.hostIp
    let ip: string | null = null

    // Primary: the WSL2 VM default gateway is the address that reaches Windows.
    ip = await new Promise<string | null>((resolve) => {
      execFile(
        'wsl.exe',
        ['-e', 'sh', '-lc', 'ip route show default'],
        { windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null)
          const clean = stdout.replace(/\0/g, '') // wsl output is sometimes UTF-16
          const m = clean.match(/via\s+(\d{1,3}(?:\.\d{1,3}){3})/)
          resolve(m ? m[1] : null)
        }
      )
    })

    // Fallback: the host-side "vEthernet (WSL)" adapter address.
    if (!ip) {
      ip = await new Promise<string | null>((resolve) => {
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like 'vEthernet (WSL*' } | Select-Object -First 1 -ExpandProperty IPAddress)"
          ],
          { windowsHide: true },
          (err, stdout) => resolve(err ? null : stdout.trim() || null)
        )
      })
    }

    this.hostIp = ip
    return ip
  }

  // ---- images (ref 351-526) ----------------------------------------------
  private async imageCurrent(name: string): Promise<boolean> {
    const inspect = await this.exec([
      'image',
      'inspect',
      name,
      '--format',
      '{{ index .Config.Labels "vivarium.version" }}'
    ])
    if (inspect.code !== 0) return false
    return inspect.stdout.trim() === IMAGE_VERSION
  }

  /**
   * Ensure the image for `variant` exists and is current, building if needed.
   * Streams build output to `sink`. Slim is always built first (full is FROM slim).
   */
  async ensureImage(variant: 'slim' | 'full', sink: LineSink, rebuild = false): Promise<boolean> {
    if (rebuild || !(await this.imageCurrent(SLIM_IMAGE))) {
      sink(`\r\n==> Building ${SLIM_IMAGE} (fast, ~1-2 minutes)\r\n`)
      const args = ['build', '-t', SLIM_IMAGE, '-f', '-']
      if (rebuild) args.push('--no-cache', '--pull')
      args.push('.')
      const code = await this.execStream(args, sink, slimDockerfile())
      if (code !== 0) {
        sink('\r\n[vivarium] slim image build failed\r\n')
        return false
      }
    }

    if (variant === 'full' && (rebuild || !(await this.imageCurrent(FULL_IMAGE)))) {
      sink(`\r\n==> Building ${FULL_IMAGE} on top of slim (one-time, ~5-10 minutes)\r\n`)
      const args = ['build', '-t', FULL_IMAGE, '-f', '-']
      if (rebuild) args.push('--no-cache') // no --pull: base is the local slim image
      args.push('.')
      const code = await this.execStream(args, sink, fullDockerfile())
      if (code !== 0) {
        sink('\r\n[vivarium] full image build failed\r\n')
        return false
      }
    }
    return true
  }

  // ---- volumes (ref 528-535) ---------------------------------------------
  private async ensureVolumes(): Promise<void> {
    for (const vol of [CREDS_VOLUME, HOME_VOLUME]) {
      const inspect = await this.exec(['volume', 'inspect', vol])
      if (inspect.code !== 0) await this.exec(['volume', 'create', vol])
    }
  }

  // ---- naming ------------------------------------------------------------
  containerName(project: Project): string {
    // One container per project; the id hash avoids collisions between projects
    // that share a folder leaf name.
    return `vivarium-${sanitize(project.name)}-${shortHash(project.id)}`
  }

  imageName(project: Project): string {
    return project.image === 'full' ? FULL_IMAGE : SLIM_IMAGE
  }

  private clipDir(project: Project): string {
    return join(app.getPath('userData'), 'clip', project.id)
  }

  // ---- shadow mounts (ref 553-566) ---------------------------------------
  // Overlay container-local named volumes on top of build-output dirs so
  // in-container installs/builds are fast and never touch the Windows checkout.
  private shadowMounts(hostDir: string, target: string, volPrefix: string): string[] {
    const vols: string[] = []
    if (existsSync(join(hostDir, 'package.json'))) {
      vols.push('-v', `${volPrefix}-nm:${target}/node_modules`)
      vols.push('-v', `${volPrefix}-ngcache:${target}/.angular`)
      if (existsSync(join(hostDir, 'extensions', 'package.json'))) {
        vols.push('-v', `${volPrefix}-extnm:${target}/extensions/node_modules`)
      }
    }
    if (existsSync(join(hostDir, 'pom.xml'))) {
      vols.push('-v', `${volPrefix}-target:${target}/target`)
    }
    return vols
  }

  // ---- run-args construction (ref 537-795, ported to /workspace) ----------
  private async buildRunArgs(project: Project): Promise<string[]> {
    const name = this.containerName(project)
    const hostIp = await this.detectHostIp()
    const forwardTarget = hostIp ?? 'host.docker.internal'

    const args: string[] = [
      'run',
      '-dt',
      // tini as PID 1. Without it PID 1 is `sleep infinity`, and the kernel
      // ignores default-action signals for PID 1 — so `docker stop`'s SIGTERM
      // does nothing and docker hangs the full 10s grace before SIGKILL. tini
      // forwards SIGTERM to the child, so the container stops in ~0.3s cleanly.
      '--init',
      '--name',
      name,
      '--label',
      'vivarium=1',
      '--label',
      `vivarium.project=${project.id}`,
      '--label',
      `vivarium.workspace=${project.basePath}`,
      '-e',
      'COLORTERM=truecolor',
      '-e',
      'TERM=xterm-256color'
    ]

    // Host access + backend forwarding.
    if (hostIp) {
      args.push('--add-host', `host.docker.internal:${hostIp}`)
    } else {
      args.push('--add-host', 'host.docker.internal:host-gateway')
    }
    args.push('-e', `HOST_FORWARD_PORTS=${BACKEND_PORTS.join(',')}`)
    args.push('-e', `HOST_FORWARD_TARGET=${forwardTarget}`)

    // Published port: FULL projects only. Slim never publishes (even if set).
    if (project.image === 'full' && project.publishedPort && project.publishedPort > 0) {
      const p = project.publishedPort
      args.push('-p', `${p}:${p}`)
    }

    // Home + creds volumes (shared across all containers).
    args.push('-v', `${HOME_VOLUME}:/home/node`)
    args.push('-v', `${CREDS_VOLUME}:/home/node/.claude`)

    // Selected mounts → /workspace/<leaf>, deduped by leaf name, plus shadows.
    // Bind mounts use --mount (not -v): a Windows source like `C:\foo` contains
    // a drive-letter colon, and docker's -v parser mis-splits it into a bogus
    // third "mode" segment ("invalid mode: /workspace/..."). --mount is
    // comma/key=value delimited, so the colon is unambiguous.
    const usedNames = new Set<string>()

    // Shared output folder: always mounted (read-write) at /workspace/output so
    // agents in every project drop artifacts to the same place. Reserve the
    // "output" leaf first so a project folder literally named "output" gets a
    // hash-suffixed target instead of colliding with this one.
    if (this.sharedOutput) {
      usedNames.add('output')
      args.push('--mount', `type=bind,source=${this.sharedOutput},target=/workspace/output`)
    }

    for (const abs of project.mounts) {
      const leafRaw = sanitize(basename(abs))
      let leaf = leafRaw
      if (usedNames.has(leaf)) leaf = `${leafRaw}-${shortHash(abs)}`
      usedNames.add(leaf)
      const target = `/workspace/${leaf}`
      args.push('--mount', `type=bind,source=${abs},target=${target}`)
      args.push(...this.shadowMounts(abs, target, `vivarium-${shortHash(abs)}`))
    }

    // Clip dir for image-paste (host-managed bind mount).
    args.push('--mount', `type=bind,source=${this.clipDir(project)},target=/clip`)

    // Hook bridge: Claude Code hook settings + event log (see bridge.ts).
    args.push('--mount', `type=bind,source=${bridgeDir(project.id)},target=/vivarium`)

    args.push('-w', '/workspace')
    args.push(this.imageName(project))
    // Keep-alive PID1 that first starts the socat relays, then sleeps forever.
    args.push('host-forward', 'sleep', 'infinity')
    return args
  }

  // ---- lifecycle ---------------------------------------------------------
  async containerExists(project: Project): Promise<boolean> {
    const r = await this.exec(['container', 'inspect', this.containerName(project)])
    return r.code === 0
  }

  async isRunning(project: Project): Promise<boolean> {
    const r = await this.exec([
      'inspect',
      '-f',
      '{{.State.Running}}',
      this.containerName(project)
    ])
    if (r.code !== 0) return false
    return r.stdout.trim() === 'true'
  }

  /** Does an existing container have the /vivarium hook-bridge mount? */
  private async hasBridgeMount(name: string): Promise<boolean> {
    const r = await this.exec([
      'inspect',
      '-f',
      '{{range .Mounts}}{{.Destination}}\n{{end}}',
      name
    ])
    if (r.code !== 0) return false
    return r.stdout.split('\n').some((l) => l.trim() === '/vivarium')
  }

  /**
   * Start (or create) the project container. Builds the image first if needed;
   * all progress streams to `sink`. Returns true on success.
   */
  async start(project: Project, sink: LineSink): Promise<boolean> {
    if (!(await this.detect())) {
      sink('\r\n[vivarium] docker not found on PATH. Start Docker/Rancher Desktop.\r\n')
      return false
    }

    const name = this.containerName(project)

    // Upgrade path: containers created before the hook bridge existed lack the
    // /vivarium mount, so agent sessions couldn't load /vivarium/hooks.json.
    // Mounts can't be added to an existing container — recreate it (safe: all
    // durable state lives in the named home/creds/shadow volumes).
    if ((await this.containerExists(project)) && !(await this.hasBridgeMount(name))) {
      sink(`\r\n==> Recreating ${name} to add the agent hook bridge mount\r\n`)
      await this.exec(['rm', '-f', name])
    }

    // Already running? Nothing to do.
    if (await this.isRunning(project)) return true

    // Refresh hook script/settings + drop stale events before every start.
    await ensureBridgeFiles(project.id)

    // Exists but stopped → just start it.
    if (await this.containerExists(project)) {
      sink(`\r\n==> Starting existing container ${name}\r\n`)
      const code = await this.execStream(['start', name], sink)
      return code === 0
    }

    // Fresh create: ensure image + volumes, then run.
    const built = await this.ensureImage(project.image, sink)
    if (!built) return false
    await this.ensureVolumes()

    // Ensure the host-side clip dir (and shared output folder, if set) exist
    // before binding them — a missing bind source fails `docker run`.
    await import('fs').then(async ({ promises }) => {
      await promises.mkdir(this.clipDir(project), { recursive: true })
      if (this.sharedOutput) {
        await promises.mkdir(this.sharedOutput, { recursive: true }).catch(() => {})
      }
    })

    sink(`\r\n==> Creating container ${name} (${this.imageName(project)})\r\n`)
    const args = await this.buildRunArgs(project)
    const code = await this.execStream(args, sink)
    if (code !== 0) {
      // docker run can leave a half-created container behind — clean it up.
      await this.exec(['rm', '-f', name])
      sink('\r\n[vivarium] docker run failed\r\n')
      return false
    }
    return true
  }

  async stop(project: Project): Promise<void> {
    // Cap the grace period at 2s. New containers run with --init and stop almost
    // instantly; this bound only matters for containers created before --init
    // (their PID 1 ignores SIGTERM) so they no longer hang the full 10s default.
    await this.exec(['stop', '-t', '2', this.containerName(project)])
  }

  async restart(project: Project, sink: LineSink): Promise<boolean> {
    await this.stop(project)
    return this.start(project, sink)
  }

  /** Remove + recreate (used after a mount / image / port change). */
  async recreate(project: Project, sink: LineSink): Promise<boolean> {
    await this.exec(['rm', '-f', this.containerName(project)])
    return this.start(project, sink)
  }

  async remove(project: Project): Promise<void> {
    await this.exec(['rm', '-f', this.containerName(project)])
  }

  /** Build the argv (minus the leading binary) for a session's exec/attach. */
  async execArgs(project: Project, kind: 'agent' | 'shell', sessionId: string): Promise<string[]> {
    const name = this.containerName(project)
    if (kind === 'agent') {
      // VIVARIUM_SESSION_ID tags this exec's hook events with the owning
      // session; --settings loads the bridge hooks without touching the shared
      // /home/node/.claude settings (claude-box sessions stay hook-free).
      return [
        'exec',
        '-it',
        '-e',
        `VIVARIUM_SESSION_ID=${sessionId}`,
        '-w',
        '/workspace',
        name,
        'claude',
        '--dangerously-skip-permissions',
        '--settings',
        '/vivarium/hooks.json'
      ]
    }
    return ['exec', '-it', '-w', '/workspace', name, 'bash']
  }

  async binaryName(): Promise<string | null> {
    return this.detect()
  }
}
