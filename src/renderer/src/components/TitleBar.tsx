import React from 'react'
import type { UsageLimit } from '@shared/types'
import { PanelToggle } from './Icons'
import { Logo } from './Logo'
import { useStore } from '../state/store'
import { chipSummary } from '../claude'

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

// Which build this is. The app ships as an installer and updates by reinstalling,
// so there was previously no way to tell one build from another — including in a
// bug report. The runtime versions ride along in the tooltip for the same reason.
function AppVersion(): React.ReactElement | null {
  const info = useStore((s) => s.appInfo)
  if (!info) return null
  return (
    <span
      title={`Vivarium ${info.version}\nElectron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`}
      style={{
        fontSize: 11.5,
        color: 'var(--text-3)',
        fontFamily: "'IBM Plex Mono', monospace",
        // Sits with the wordmark, not with the live chips on the right — this is
        // identity, not status, and it must never draw the eye.
        opacity: 0.75
      }}
    >
      v{info.version}
    </span>
  )
}

// Claude Code version chip + the only entry point to the manual-update dialog.
// Updates are rare (months apart), so this stays deliberately quiet: muted grey
// text while every container is current, and it only earns colour + a dot when
// something is actually behind npm's latest. No badge, no toast, no nagging —
// glance at it or don't.
function ClaudeChip(): React.ReactElement | null {
  const status = useStore((s) => s.claude)
  const checking = useStore((s) => s.claudeChecking)
  const openClaudeUpdate = useStore((s) => s.openClaudeUpdate)
  const names = useStore((s) => {
    const out: Record<string, string> = {}
    for (const p of s.config.projects) out[p.id] = p.name
    return out
  })
  const [hover, setHover] = React.useState(false)

  const chip = chipSummary(status, names)
  if (!chip) return null // first check hasn't landed / nothing to say
  const behind = chip.behind > 0

  return (
    <>
      {/* same thin rule the usage windows use, so the two groups read apart */}
      <span style={{ width: 1, height: 16, background: 'var(--border)', flex: 'none' }} />
      <button
        title={chip.tooltip}
        onClick={openClaudeUpdate}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 24,
          padding: '0 8px',
          border: 0,
          borderRadius: 4,
          background: hover ? 'var(--row-hover)' : 'transparent',
          color: behind ? 'var(--text)' : 'var(--text-3)',
          fontSize: 13,
          cursor: 'pointer',
          flex: 'none',
          opacity: checking ? 0.6 : 1,
          ...noDrag
        }}
      >
        {behind && (
          <span
            style={{ width: 6, height: 6, borderRadius: '50%', background: '#f1c21b', flex: 'none' }}
          />
        )}
        <span style={{ color: behind ? 'var(--text-2)' : 'inherit' }}>claude</span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5 }}>
          {chip.label}
          {/* mixed versions across containers: the chip shows the oldest, the
              tooltip lists them all — the marker stops it reading as the truth */}
          {chip.mixed && '+'}
        </span>
        {behind && status?.latest && (
          <span
            style={{
              color: 'var(--accent-2)',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12.5
            }}
          >
            → {status.latest}
          </span>
        )}
      </button>
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
        <AppVersion />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', height: 40 }}>
        {/* No noDrag on the wrapper: the usage chips are hover-tooltip-only, so
            the region stays draggable (tooltips still fire over a drag region).
            The version chip opts out on its own — it's the one click target. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginRight: 16 }}>
          {/* usage chips first so their position doesn't shift when the version
              chip appears or disappears — they're the ones read at a glance */}
          <UsageChips />
          <ClaudeChip />
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
