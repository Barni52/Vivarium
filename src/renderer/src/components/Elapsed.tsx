import React from 'react'

// Live durations for agent turns. The ticking lives in its own tiny component so
// a running agent re-renders three characters of text rather than a whole
// sidebar row (or the terminal header) once a second.

/**
 * Compact duration: seconds below a minute, whole minutes below an hour, then
 * hours + minutes. Never "0s" — a turn that has just started reads "1s", since a
 * zero looks like a broken indicator rather than a fast agent.
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * A duration from `since` (epoch ms) that keeps itself current.
 *
 * The interval follows the granularity on screen: every second while the reading
 * is in seconds, then every 15s once only whole minutes can change — an agent
 * that has been working for an hour shouldn't cost 3600 re-renders to display
 * "58m".
 */
export function Elapsed({
  since,
  style
}: {
  since: number
  style?: React.CSSProperties
}): React.ReactElement {
  const [now, setNow] = React.useState(() => Date.now())
  const elapsed = Math.max(0, now - since)
  const fast = elapsed < 60_000
  React.useEffect(() => {
    // Re-created when the cadence changes (crossing the one-minute mark) or the
    // clock is restarted by a new turn.
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 15_000)
    return () => clearInterval(t)
  }, [fast, since])
  return <span style={style}>{formatElapsed(elapsed)}</span>
}
