import type { ClaudeStatus, ClaudeVersionInfo } from '@shared/types'

// Version arithmetic for the Claude Code chip + dialog. Lives in the renderer
// because main only reports raw facts ("installed X", "npm says Y") — deciding
// what counts as behind, and how to phrase it, is a UI concern.

/** Numeric-triple compare. null when either side isn't a parsable x.y.z. */
export function compareVersions(a: string | null, b: string | null): number | null {
  const parse = (v: string | null): number[] | null => {
    const m = v?.match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  // Equal triples with different suffixes (e.g. a prerelease tag) count as
  // equal — offering an "update" to the same x.y.z would be noise.
  return 0
}

export function isBehind(installed: string | null, latest: string | null): boolean {
  return compareVersions(installed, latest) === -1
}

/** Reason a container's version couldn't be read — full phrasing, for tooltips. */
export function reasonLabel(reason: ClaudeVersionInfo['reason']): string {
  switch (reason) {
    case 'stopped':
      return 'container stopped'
    case 'no-container':
      return 'no container yet'
    case 'docker-missing':
      return 'docker not running'
    default:
      return 'version unreadable'
  }
}

/** Same reason, short enough for the dialog's status column (never wraps). */
export function reasonShort(reason: ClaudeVersionInfo['reason']): string {
  switch (reason) {
    case 'stopped':
      return 'stopped'
    case 'no-container':
      return 'no container'
    case 'docker-missing':
      return 'docker off'
    default:
      return 'unreadable'
  }
}

/** Projects whose container is running an older Claude Code than npm's latest. */
export function behindIds(status: ClaudeStatus | null): string[] {
  if (!status) return []
  return status.containers.filter((c) => isBehind(c.installed, status.latest)).map((c) => c.projectId)
}

export interface ChipSummary {
  /** version shown on the chip; '—' when nothing could be read */
  label: string
  /** how many containers are behind latest */
  behind: number
  /** containers disagree about the installed version */
  mixed: boolean
  tooltip: string
}

/**
 * Collapse the per-container detail into the one line the title bar can show.
 * The chip reports the *oldest* installed version — that's the one an update
 * would fix, and it's what makes the "behind" state honest when containers
 * disagree. Returns null when there is nothing worth putting in the title bar.
 */
export function chipSummary(
  status: ClaudeStatus | null,
  names: Record<string, string>
): ChipSummary | null {
  if (!status) return null
  const known = status.containers.filter((c) => c.installed)
  const versions = new Set(known.map((c) => c.installed as string))
  // Nothing installed readable and no npm answer either → don't clutter the bar.
  if (known.length === 0 && !status.latest) return null

  const oldest = [...versions].sort((a, b) => compareVersions(a, b) ?? a.localeCompare(b))[0] ?? null
  const behind = behindIds(status).length

  const lines: string[] = ['Claude Code in your containers — click to manage']
  lines.push(
    status.latest
      ? `newest on npm: ${status.latest}`
      : `npm check failed (${status.latestError ?? 'unknown'})`
  )
  lines.push('')
  for (const c of status.containers) {
    const name = names[c.projectId] ?? c.projectId
    if (!c.installed) {
      lines.push(`${name}: ${reasonLabel(c.reason)}`)
    } else {
      lines.push(`${name}: ${c.installed}${isBehind(c.installed, status.latest) ? '  ← older' : ''}`)
    }
  }
  return {
    label: oldest ?? '—',
    behind,
    mixed: versions.size > 1,
    tooltip: lines.join('\n')
  }
}
