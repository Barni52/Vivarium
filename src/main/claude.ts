import type {
  ClaudeStatus,
  ClaudeUpdateResult,
  ClaudeVersionInfo,
  Project
} from '@shared/types'
import type { DockerService } from './docker'

// Claude Code version tracking for the manual-update UI.
//
// The CLI is installed inside each container (image layer, plus whatever a
// manual update wrote into the writable layer), so "the installed version" is
// per-project, not global — hence a list rather than a single number. Vivarium
// deliberately does NOT auto-update it: updates only happen when the user asks
// (see docker.updateClaude). All this service adds on top is "what's the newest
// published version", so the UI can say whether asking is worth it.

const REGISTRY_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'

// The npm registry is cheap and heavily cached, but a status call happens on
// every container start/stop too — reuse a recent answer instead of re-asking.
// An explicit refresh (the dialog's ⟳, and opening the dialog) forces a fetch.
const LATEST_TTL = 10 * 60 * 1000

export class ClaudeService {
  private latest: string | null = null
  private latestError: string | undefined
  private checkedAt = 0

  constructor(private docker: DockerService) {}

  /** GET the `latest` dist-tag off the npm registry. Never throws. */
  private async fetchLatest(force: boolean): Promise<void> {
    if (!force && this.latest && Date.now() - this.checkedAt < LATEST_TTL) return
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 10_000)
    try {
      // The `latest` document is a full packument entry; only `version` matters.
      const r = await fetch(REGISTRY_URL, {
        headers: { accept: 'application/json' },
        signal: ctl.signal
      })
      if (!r.ok) {
        this.latestError = `http-${r.status}`
        return
      }
      const body = (await r.json().catch(() => null)) as { version?: string } | null
      if (typeof body?.version !== 'string' || !body.version) {
        this.latestError = 'bad-response'
        return
      }
      this.latest = body.version
      this.latestError = undefined
      this.checkedAt = Date.now()
    } catch {
      // Offline / DNS failure / abort. Keep the last known `latest` (better than
      // nothing — the per-container versions are still worth showing).
      this.latestError = 'network'
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * Newest published version + the version installed in each project's
   * container. Container probes run sequentially: this is a handful of
   * `docker exec`s at most, and they're never on a hot path.
   */
  async status(projects: Project[], force = false): Promise<ClaudeStatus> {
    await this.fetchLatest(force)
    const containers: ClaudeVersionInfo[] = []
    for (const p of projects) containers.push(await this.docker.claudeVersion(p))
    return {
      latest: this.latest,
      latestError: this.latest ? undefined : this.latestError,
      checkedAt: this.checkedAt,
      containers
    }
  }

  /**
   * Install the newest Claude Code in one project's container and read the
   * version back, so the UI reports what actually landed rather than what npm
   * was asked for.
   */
  async update(project: Project): Promise<ClaudeUpdateResult> {
    const r = await this.docker.updateClaude(project)
    if (r.code !== 0) {
      return { ok: false, version: null, message: tail(r.stderr || r.stdout, r.code) }
    }
    const after = await this.docker.claudeVersion(project)
    return { ok: true, version: after.installed }
  }
}

/**
 * Last few meaningful lines of npm's output, for the error row in the dialog.
 * npm failures are pages long and mostly boilerplate; the tail carries the
 * actual cause (EACCES, ETARGET, network) and the full log path.
 */
function tail(output: string, code: number): string {
  const lines = output
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l && !/^npm (notice|warn)\b/i.test(l))
  if (code === 124) return 'timed out after 6 minutes'
  if (lines.length === 0) return `npm exited with code ${code}`
  return lines.slice(-3).join(' · ').slice(0, 300)
}
