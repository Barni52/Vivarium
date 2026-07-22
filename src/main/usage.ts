import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageLimit, UsageSnapshot } from '@shared/types'
import type { DockerService } from './docker'

// Claude plan usage via the undocumented OAuth endpoint the Claude Code CLI's
// /usage command uses. Auth reuses the existing Claude Code OAuth token —
// Vivarium NEVER refreshes tokens itself (that's claude's job; every agent run
// rewrites the shared-volume copy), it only reads the freshest copy it can
// find: host ~/.claude first (present if claude was ever run on Windows), then
// the claude-box-creds volume through docker. On 401 the cache is dropped and
// the sources are re-read once — an agent may have rotated the token since.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

interface OauthCreds {
  accessToken: string
  /** epoch ms; 0 when the file omitted it (then only a 401 invalidates) */
  expiresAt: number
}

// Response shape as observed 2026-07 — undocumented, so every field is
// optional and parsing is defensive.
interface RawWindow {
  utilization?: number
  resets_at?: string
}
interface RawLimit {
  kind?: string
  percent?: number
  severity?: string
  resets_at?: string
  is_active?: boolean
  scope?: { model?: { display_name?: string } } | null
}
interface RawUsage {
  limits?: RawLimit[]
  five_hour?: RawWindow | null
  seven_day?: RawWindow | null
}

function parseSnapshot(body: RawUsage): UsageSnapshot {
  const limits: UsageLimit[] = []
  for (const l of Array.isArray(body.limits) ? body.limits : []) {
    if (typeof l?.percent !== 'number') continue
    limits.push({
      kind: String(l.kind ?? ''),
      percent: l.percent,
      severity: String(l.severity ?? 'normal'),
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
      modelName:
        typeof l.scope?.model?.display_name === 'string' ? l.scope.model.display_name : null,
      isActive: !!l.is_active
    })
  }
  // Variants without a `limits` array: synthesize from the two fixed windows.
  if (limits.length === 0) {
    for (const [kind, w] of [
      ['session', body.five_hour],
      ['weekly_all', body.seven_day]
    ] as const) {
      if (typeof w?.utilization !== 'number') continue
      limits.push({
        kind,
        percent: w.utilization,
        severity: 'normal',
        resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
        modelName: null,
        isActive: false
      })
    }
  }
  return { ok: true, limits, fetchedAt: Date.now() }
}

export class UsageService {
  private creds: OauthCreds | null = null
  /** epoch ms until which the endpoint told us to back off (429 Retry-After).
   * Measured limit is ~5 requests / 5 min; a trip locks the rest of the
   * window, so requests during the backoff are guaranteed 429s — skip them. */
  private blockedUntil = 0

  constructor(private docker: DockerService) {}

  private async acquireToken(): Promise<OauthCreds | null> {
    const sources: Array<() => Promise<string | null>> = [
      () => readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8').catch(() => null),
      () => this.docker.readSharedCredentials()
    ]
    for (const read of sources) {
      const raw = await read()
      if (!raw) continue
      try {
        const o = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } })
          .claudeAiOauth
        if (typeof o?.accessToken === 'string' && o.accessToken) {
          return { accessToken: o.accessToken, expiresAt: Number(o.expiresAt) || 0 }
        }
      } catch {
        // malformed file — try the next source
      }
    }
    return null
  }

  private async token(force: boolean): Promise<OauthCreds | null> {
    // 60s slack so a token about to expire mid-request isn't used.
    const fresh =
      this.creds && (this.creds.expiresAt === 0 || this.creds.expiresAt - 60_000 > Date.now())
    if (!force && fresh) return this.creds
    this.creds = await this.acquireToken()
    return this.creds
  }

  private async request(
    token: string
  ): Promise<{ status: number; body: RawUsage | null; retryAfter: number | null }> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 10_000)
    try {
      const r = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: ctl.signal
      })
      const ra = Number(r.headers.get('retry-after'))
      const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : null
      if (!r.ok) return { status: r.status, body: null, retryAfter }
      return {
        status: r.status,
        body: (await r.json().catch(() => null)) as RawUsage | null,
        retryAfter
      }
    } catch {
      return { status: 0, body: null, retryAfter: null } // network failure / timeout
    } finally {
      clearTimeout(t)
    }
  }

  async fetch(): Promise<UsageSnapshot> {
    const fail = (error: string): UsageSnapshot => ({
      ok: false,
      error,
      limits: [],
      fetchedAt: Date.now()
    })
    if (Date.now() < this.blockedUntil) return fail('rate-limited')
    let creds = await this.token(false)
    if (!creds) return fail('no-credentials')
    let res = await this.request(creds.accessToken)
    if (res.status === 401 || res.status === 403) {
      creds = await this.token(true)
      if (!creds) return fail('no-credentials')
      res = await this.request(creds.accessToken)
      if (res.status === 401 || res.status === 403) return fail('auth-expired')
    }
    if (res.status === 429) {
      this.blockedUntil = Date.now() + (res.retryAfter ?? 300) * 1000
      return fail('rate-limited')
    }
    if (res.status === 0) return fail('network')
    if (!res.body) return fail(`http-${res.status}`)
    return parseSnapshot(res.body)
  }
}
