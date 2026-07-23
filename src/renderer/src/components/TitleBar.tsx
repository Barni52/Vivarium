import React from 'react'
import type { UsageLimit } from '@shared/types'
import { PanelToggle } from './Icons'
import { Logo } from './Logo'
import { useStore } from '../state/store'

// Frameless custom title bar (mockup lines 308-322). The bar is draggable via
// -webkit-app-region; buttons opt out so they stay clickable.
const drag: React.CSSProperties = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function WinButton({
  onClick,
  hoverBg,
  hoverColor,
  children
}: {
  onClick: () => void
  hoverBg: string
  hoverColor?: string
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 42,
        border: 0,
        background: hover ? hoverBg : 'transparent',
        color: hover && hoverColor ? hoverColor : 'var(--text-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
        ...noDrag
      }}
    >
      {children}
    </button>
  )
}

function limitTitle(l: UsageLimit): string {
  const what = l.kind === 'session' ? 'Session (5h) limit' : 'Weekly (7d) limit, all models'
  const reset = l.resetsAt
    ? ` — resets ${new Date(l.resetsAt).toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })}`
    : ''
  const sev = l.severity !== 'normal' ? ` (${l.severity})` : ''
  return `${what}: ${Math.round(l.percent)}% used${sev}${reset}`
}

// Time until reset. Derived from the last API response's resets_at against the
// local clock, so it ticks between polls and re-syncs whenever a fresh snapshot
// lands. Clamped at zero — the next poll brings the new window. The session (5h)
// window reads "XXh XXm"; the weekly window can be days out, so `days` switches
// it to "XXd XXh".
function countdown(resetsAt: string | null, now: number, days = false): string | null {
  if (!resetsAt) return null
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms)) return null
  const mins = Math.max(0, Math.floor(ms / 60_000))
  if (days) {
    const hrs = Math.floor(mins / 60)
    return `${Math.floor(hrs / 24)}d ${String(hrs % 24).padStart(2, '0')}h`
  }
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

function UsageChip({
  limit,
  now,
  staleNote
}: {
  limit: UsageLimit
  now: number
  staleNote: string
}): React.ReactElement {
  const pct = Math.max(0, Math.min(100, limit.percent))
  const color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? '#f1c21b' : '#42be65'
  const cd = countdown(limit.resetsAt, now, limit.kind !== 'session')
  return (
    <span
      title={limitTitle(limit) + staleNote}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        flex: 'none',
        opacity: staleNote ? 0.55 : 1
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
        {limit.kind === 'session' ? '5h' : '7d'}
      </span>
      <span
        style={{
          width: 62,
          height: 8,
          borderRadius: 4,
          background: 'var(--border)',
          overflow: 'hidden',
          display: 'flex'
        }}
      >
        <span style={{ width: `${pct}%`, background: color }} />
      </span>
      <span style={{ fontSize: 13, color: 'var(--text-2)', minWidth: 29 }}>
        {Math.round(pct)}%
      </span>
      {cd && <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{cd}</span>}
    </span>
  )
}

// Claude plan usage chips (main/usage.ts via the store's 3-minute poll): the
// 5h session window and the 7d all-models window — per-model limits
// deliberately not rendered, the tooltip carries the detail. Rendered in the
// title bar so limits are visible no matter which session is open.
function UsageChips(): React.ReactElement | null {
  const usage = useStore((s) => s.usage)
  // Local 30s tick: between polls the countdown interpolates off the app
  // clock; the values re-sync whenever refreshUsage lands a fresh snapshot.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  if (!usage) return null // first poll not landed yet
  const shown = usage.limits.filter((l) => l.kind === 'session' || l.kind === 'weekly_all')
  if (!usage.ok || shown.length === 0) {
    const title =
      usage.error === 'no-credentials'
        ? 'No Claude credentials found (host ~/.claude or the claude-box-creds volume)'
        : usage.error === 'auth-expired'
          ? 'Claude sign-in expired — run any agent so claude refreshes the token'
          : usage.error === 'rate-limited'
            ? 'Usage endpoint rate-limited — backing off, retrying automatically'
            : `Could not fetch Claude usage (${usage.error ?? 'empty response'})`
    return <span style={{ fontSize: 13, color: 'var(--text-3)' }} title={title}>usage n/a</span>
  }
  // The store keeps the last good snapshot through failed polls — flag it once
  // it's older than 1.5 poll intervals (a sync was missed), with the chips
  // dimmed and the age in the tooltip. The countdown stays live regardless.
  const ageMin = Math.round((now - usage.fetchedAt) / 60_000)
  const staleNote = now - usage.fetchedAt > 270_000 ? ` — last synced ${ageMin}m ago` : ''
  return (
    <>
      {shown.map((l, i) => (
        <React.Fragment key={l.kind}>
          {/* thin vertical rule so the 5h and 7d windows read as separate groups */}
          {i > 0 && <span style={{ width: 1, height: 16, background: 'var(--border)', flex: 'none' }} />}
          <UsageChip limit={l} now={now} staleNote={staleNote} />
        </React.Fragment>
      ))}
    </>
  )
}

export function TitleBar(): React.ReactElement {
  const v = window.vivarium
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const [toggleHover, setToggleHover] = React.useState(false)
  return (
    <div
      style={{
        height: 40,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--win)',
        borderBottom: '1px solid var(--border-2)',
        userSelect: 'none',
        paddingLeft: 12,
        ...drag
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <button
          title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={toggleSidebar}
          onMouseEnter={() => setToggleHover(true)}
          onMouseLeave={() => setToggleHover(false)}
          style={{
            width: 36,
            height: 30,
            border: 0,
            background: toggleHover ? 'var(--row-hover)' : 'transparent',
            color: collapsed ? 'var(--text-2)' : 'var(--accent-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            borderRadius: 5,
            ...noDrag
          }}
        >
          <PanelToggle size={22} />
        </button>
        <Logo size={22} style={{ flex: 'none' }} />
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '.3px' }}>Vivarium</span>
        <span style={{ fontSize: 13, color: 'var(--text-3)', fontWeight: 400 }}>session manager</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', height: 40 }}>
        {/* No noDrag here: the chips are hover-tooltip-only (no click targets), so
            keep this region draggable — tooltips still fire over a drag region. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginRight: 16 }}>
          <UsageChips />
        </div>
        <div style={{ display: 'flex', alignItems: 'stretch', height: 40 }}>
          <WinButton onClick={() => v.windowMinimize()} hoverBg="var(--row-hover)">
            <svg width="11" height="11" viewBox="0 0 10 10">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </WinButton>
          <WinButton onClick={() => v.windowMaximize()} hoverBg="var(--row-hover)">
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
            </svg>
          </WinButton>
          <WinButton onClick={() => v.windowClose()} hoverBg="#da1e28" hoverColor="#fff">
            <svg width="11" height="11" viewBox="0 0 10 10">
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </WinButton>
        </div>
      </div>
    </div>
  )
}
