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
 * A duration from `since` (epoch ms) that keeps itself current — or holds at
 * `until` if that is given, which is how a stopped clock is drawn: an agent
 * blocked on the user is not working, and a number still climbing next to it
 * reads as one that is.
 *
 * The interval follows the granularity on screen: every second while the reading
 * is in seconds, then every 15s once only whole minutes can change — an agent
 * that has been working for an hour shouldn't cost 3600 re-renders to display
 * "58m".
 */
export function Elapsed({
  since,
  until,
  style
}: {
  since: number
  /** frozen end of the span; omit for "now" */
  until?: number
  style?: React.CSSProperties
}): React.ReactElement {
  const [now, setNow] = React.useState(() => Date.now())
  const frozen = until !== undefined
  const elapsed = Math.max(0, (until ?? now) - since)
  const fast = elapsed < 60_000
  React.useEffect(() => {
    if (frozen) return // nothing to tick, and no interval to leave running
    // `now` went stale while the clock was held (and after a new turn stamped an
    // older `since`), so re-read it before waiting out the first interval.
    setNow(Date.now())
    // Re-created when the cadence changes (crossing the one-minute mark) or the
    // clock is restarted by a new turn.
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 15_000)
    return () => clearInterval(t)
  }, [fast, since, frozen])
  return <span style={style}>{formatElapsed(elapsed)}</span>
}
