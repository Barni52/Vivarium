import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import type { ClaudeVersionInfo, Project } from '@shared/types'
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

export interface ExecResult {
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
  // `timeoutMs` guards the commands that talk to a possibly-wedged container
  // (version probe, npm install): docker exec has no timeout of its own and a
  // hung child would leave the caller's spinner up forever.
  private async exec(args: string[], timeoutMs?: number): Promise<ExecResult> {
    const bin = await this.docker()
    return new Promise((resolve) => {
      const child = spawn(bin, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (r: ExecResult): void => {
        if (timer) clearTimeout(timer)
        resolve(r)
      }
      if (timeoutMs) {
        timer = setTimeout(() => {
          child.kill()
          // 124 mirrors coreutils `timeout` so callers can tell it apart.
          done({ code: 124, stdout, stderr: stderr || 'timed out' })
        }, timeoutMs)
      }
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('close', (code) => done({ code: code ?? 0, stdout, stderr }))
      child.on('error', () => done({ code: 1, stdout, stderr: stderr || 'spawn failed' }))
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

  // ---- shared Claude credentials (for the usage endpoint) -----------------
  /**
   * Read `.credentials.json` out of the shared creds volume. Prefer `docker
   * exec` into any running vivarium container (instant, no image needed); fall
   * back to a throwaway busybox run mounting the volume read-only — busybox
   * (~1 MB) is pulled once on first use. Returns null when docker is missing,
   * nothing is running and busybox can't be pulled, or the file doesn't exist.
   */
  async readSharedCredentials(): Promise<string | null> {
    try {
      const ps = await this.exec(['ps', '--filter', 'name=vivarium-', '--format', '{{.Names}}'])
      const name = ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)[0]
      if (ps.code === 0 && name) {
        const r = await this.exec(['exec', name, 'cat', '/home/node/.claude/.credentials.json'])
        if (r.code === 0 && r.stdout.trim()) return r.stdout
      }
      const r = await this.exec([
        'run',
        '--rm',
        '-v',
        `${CREDS_VOLUME}:/creds:ro`,
        'busybox',
        'cat',
        '/creds/.credentials.json'
      ])
      return r.code === 0 && r.stdout.trim() ? r.stdout : null
    } catch {
      return null // docker-missing
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
      return (await this.execStream(['start', name], sink)) === 0
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

  // ---- Claude Code version (manual updates, see main/claude.ts) -----------
  /**
   * Read the Claude Code version installed inside a project's container.
   * The CLI lives in the container's own filesystem, so this only works while
   * it runs — a stopped or not-yet-created container has no version to report,
   * and the reason is surfaced in the UI rather than guessed at.
   */
  async claudeVersion(project: Project): Promise<ClaudeVersionInfo> {
    const base = { projectId: project.id }
    if (!(await this.detect())) return { ...base, installed: null, reason: 'docker-missing' }
    if (!(await this.containerExists(project))) return { ...base, installed: null, reason: 'no-container' }
    if (!(await this.isRunning(project))) return { ...base, installed: null, reason: 'stopped' }
    const r = await this.exec(['exec', this.containerName(project), 'claude', '--version'], 20_000)
    // `claude --version` prints e.g. "2.2.0 (Claude Code)" — take the semver.
    const m = r.stdout.match(/\d+\.\d+\.\d+[^\s]*/)
    if (r.code !== 0 || !m) return { ...base, installed: null, reason: 'error' }
    return { ...base, installed: m[0] }
  }

  /**
   * Install the newest Claude Code inside the container, replacing the copy
   * baked into the image. The image installs it as root under
   * /usr/local/lib/node_modules but the container runs as `node`, so Claude's
   * own auto-updater can't write there — we install out of band with the node
   * user's passwordless sudo (see the sudoers line in dockerfiles.ts). npm and
   * node both sit in /usr/local/bin, which is on sudo's default secure_path.
   *
   * Awaited (unlike everything else here that shells out in the background):
   * the caller drives a progress row and reports the outcome. Two consequences
   * the UI has to spell out — a `claude` already running keeps its in-memory
   * version until the session is relaunched, and because the install lands in
   * the container's writable layer a later `recreate` (mount/image/port change)
   * reverts it to the image's version. That's deliberate: the version chip
   * re-flags it on the next check instead of silently self-healing.
   */
  async updateClaude(project: Project): Promise<ExecResult> {
    // 6 min: a cold npm cache on a slow link genuinely takes minutes, and a
    // half-finished install is worse than a slow one.
    return this.exec(
      [
        'exec',
        this.containerName(project),
        'sudo',
        'npm',
        'install',
        '-g',
        '--no-fund',
        '--no-audit',
        '@anthropic-ai/claude-code@latest'
      ],
      360_000
    )
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
      const args = [
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
      // Resume-across-restart: pin Claude's own conversation id. `--session-id`
      // starts a fresh conversation with that id (and errors if it already
      // exists); `--resume` re-attaches an existing one (and errors if it
      // doesn't). So branch on whether the transcript already exists on the
      // persistent .claude volume — this mirrors Claude's own "id already in
      // use" test and self-heals a session that was opened but never messaged
      // (no transcript yet → treat as fresh). Legacy sessions are backfilled
      // with a claudeSessionId on config load; only truly-missing ids fall
      // through to a bare (unpinned, non-resumable) claude.
      const claudeId = project.sessions.find((s) => s.id === sessionId)?.claudeSessionId
      if (claudeId) {
        const resume = await this.claudeConversationExists(name, claudeId)
        args.push(resume ? '--resume' : '--session-id', claudeId)
      }
      return args
    }
    return ['exec', '-it', '-w', '/workspace', name, 'bash']
  }

  /**
   * Does a Claude Code conversation transcript for `uuid` already exist inside
   * the container? Claude writes them to
   * $CLAUDE_CONFIG_DIR/projects/<escaped-cwd>/<uuid>.jsonl on the persistent
   * claude-box-creds volume (cwd is always /workspace here, escaping to
   * `-workspace`). We glob across the projects dir rather than hardcoding the
   * escaped-cwd folder, so a change to Claude's path-escaping can't silently
   * break the check. A failed/again-unavailable exec returns false → we fall
   * back to starting a fresh conversation. The uuid is Vivarium-generated
   * (hex + hyphens), so it is safe to interpolate into the shell command.
   */
  private async claudeConversationExists(container: string, uuid: string): Promise<boolean> {
    const res = await this.exec([
      'exec',
      container,
      'sh',
      '-c',
      `ls /home/node/.claude/projects/*/${uuid}.jsonl 2>/dev/null`
    ])
    return res.code === 0 && res.stdout.trim() !== ''
  }

  async binaryName(): Promise<string | null> {
    return this.detect()
  }
}
