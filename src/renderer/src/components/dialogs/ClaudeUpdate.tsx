import React from 'react'
import type { ClaudeVersionInfo } from '@shared/types'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'
import { Refresh, Sparkle } from '../Icons'
import { ACCENT, MONO } from '../../theme'
import { behindIds, isBehind, reasonLabel, reasonShort } from '../../claude'

// Manual Claude Code updates. Vivarium never updates the CLI on its own (an
// auto-updater ran on every container start once — it was invisible, and it
// meant the version could change under a session without anyone asking), so
// this dialog is the only place an install happens.
//
// The thing users forget between visits — this is rare, months apart — is
// *where* Claude Code lives: one copy per container, not one on Windows. The
// per-project rows make that structural fact the shape of the UI instead of a
// sentence someone has to read.

function timeAgo(ts: number): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function SmallButton({
  onClick,
  accent,
  children
}: {
  onClick: () => void
  accent?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 26,
        padding: '0 11px',
        border: '1px solid',
        borderColor: accent ? 'var(--accent)' : 'var(--border)',
        background: hover ? (accent ? 'var(--accent)' : 'var(--field)') : 'transparent',
        color: hover && accent ? '#fff' : accent ? 'var(--accent-2)' : 'var(--text-2)',
        fontSize: 12,
        cursor: 'pointer',
        flex: 'none'
      }}
    >
      {children}
    </button>
  )
}

function Row({ info, latest }: { info: ClaudeVersionInfo; latest: string | null }): React.ReactElement {
  const project = useStore((s) => s.config.projects.find((p) => p.id === info.projectId))
  const updating = useStore((s) => !!s.claudeUpdating[info.projectId])
  const result = useStore((s) => s.claudeResults[info.projectId])
  const updateClaudeIn = useStore((s) => s.updateClaudeIn)
  const behind = isBehind(info.installed, latest)

  // Right-hand column: exactly one of installing / failed / just-updated /
  // update-button / plain status.
  const right = ((): React.ReactElement => {
    if (updating) {
      return (
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-2)',
            animation: 'vpending 1.2s ease-in-out infinite'
          }}
        >
          installing…
        </span>
      )
    }
    if (result && !result.ok) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--danger)' }}>failed</span>
          <SmallButton onClick={() => void updateClaudeIn(info.projectId)}>Retry</SmallButton>
        </span>
      )
    }
    if (result?.ok) {
      return <span style={{ fontSize: 12, color: '#42be65' }}>updated ✓</span>
    }
    if (behind) {
      return (
        <SmallButton accent onClick={() => void updateClaudeIn(info.projectId)}>
          Update
        </SmallButton>
      )
    }
    if (info.installed) return <span style={{ fontSize: 12, color: 'var(--text-3)' }}>up to date</span>
    return (
      <span style={{ fontSize: 12, color: 'var(--text-3)' }} title={reasonLabel(info.reason)}>
        {reasonShort(info.reason)}
      </span>
    )
  })()

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 44,
        padding: '0 24px',
        borderTop: '1px solid var(--border-2)'
      }}
    >
      {/* same rounded-square vocabulary as the sidebar's container indicator */}
      <span
        style={{
          width: 8,
          height: 8,
          flex: 'none',
          borderRadius: 2.5,
          background: info.installed ? (behind ? '#f1c21b' : '#42be65') : 'transparent',
          border: `1.5px solid ${info.installed ? (behind ? '#f1c21b' : '#42be65') : 'var(--text-3)'}`
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {project?.name ?? 'unknown project'}
      </span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 12.5,
          color: info.installed ? 'var(--text-2)' : 'var(--text-3)',
          flex: 'none'
        }}
      >
        {result?.ok && result.version ? result.version : (info.installed ?? '—')}
      </span>
      <span
        style={{
          width: 104,
          display: 'flex',
          justifyContent: 'flex-end',
          flex: 'none',
          whiteSpace: 'nowrap'
        }}
      >
        {right}
      </span>
    </div>
  )
}

export function ClaudeUpdate(): React.ReactElement | null {
  const status = useStore((s) => s.claude)
  const checking = useStore((s) => s.claudeChecking)
  const updating = useStore((s) => s.claudeUpdating)
  const results = useStore((s) => s.claudeResults)
  const closeDialog = useStore((s) => s.closeDialog)
  const refreshClaude = useStore((s) => s.refreshClaude)
  const updateClaudeAll = useStore((s) => s.updateClaudeAll)
  const [refreshHover, setRefreshHover] = React.useState(false)

  const behind = behindIds(status)
  const busy = Object.keys(updating).length > 0
  const updated = Object.values(results).filter((r) => r.ok).length
  const failure = Object.values(results).find((r) => !r.ok)
  // Containers we can't reach at all (stopped / never created) — the one thing
  // about this feature that surprises people, so it gets a sentence.
  const unreachable = (status?.containers ?? []).filter(
    (c) => c.reason === 'stopped' || c.reason === 'no-container'
  ).length

  return (
    <Overlay onClose={busy ? (): void => {} : closeDialog}>
      <Panel width={520}>
        <div style={{ padding: '20px 24px 18px 24px', flex: 'none' }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: '.6px',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 7
            }}
          >
            <Sparkle size={12} color={ACCENT.agent} />
            Claude Code
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ fontSize: 19, fontWeight: 600 }}>
              {status?.latest ? `${status.latest} on npm` : 'Version unknown'}
            </div>
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-3)',
                flex: 1,
                animation: checking ? 'vpending 1.2s ease-in-out infinite' : 'none'
              }}
            >
              {checking
                ? 'checking…'
                : status?.latest
                  ? `checked ${timeAgo(status.checkedAt)}`
                  : `npm check failed (${status?.latestError ?? 'unknown'})`}
            </span>
            <button
              title="Check npm again and re-read every container"
              onClick={() => void refreshClaude(true)}
              onMouseEnter={() => setRefreshHover(true)}
              onMouseLeave={() => setRefreshHover(false)}
              style={{
                width: 28,
                height: 28,
                border: 0,
                background: refreshHover ? 'var(--field-2)' : 'transparent',
                color: refreshHover ? 'var(--text)' : 'var(--text-2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flex: 'none'
              }}
            >
              <Refresh />
            </button>
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55, marginTop: 10 }}>
            Claude Code is installed inside each project container, so it&rsquo;s updated per
            container and only when you ask — nothing on Windows changes.
          </div>
        </div>

        <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: '0 1 auto' }}>
          {(status?.containers ?? []).map((c) => (
            <Row key={c.projectId} info={c} latest={status?.latest ?? null} />
          ))}
          {status && status.containers.length === 0 && (
            <div
              style={{
                padding: '14px 24px 18px 24px',
                borderTop: '1px solid var(--border-2)',
                fontSize: 12.5,
                fontStyle: 'italic',
                color: 'var(--text-3)'
              }}
            >
              No projects yet.
            </div>
          )}
        </div>

        {/* Consequences worth one line each, shown only once they apply. */}
        {(updated > 0 || failure || unreachable > 0) && (
          <div
            style={{
              flex: 'none',
              padding: '12px 24px',
              borderTop: '1px solid var(--border-2)',
              background: 'var(--field)',
              fontSize: 12,
              color: 'var(--text-2)',
              lineHeight: 1.5
            }}
          >
            {unreachable > 0 && (
              <div>
                npm has to run <em>inside</em> a container, so the{' '}
                {unreachable === 1 ? 'one that isn’t running' : `${unreachable} that aren’t running`}{' '}
                can’t be updated from here — start {unreachable === 1 ? 'it' : 'them'} and the
                version shows up above.
              </div>
            )}
            {updated > 0 && (
              <div style={{ marginTop: unreachable > 0 ? 8 : 0 }}>
                Agent sessions that are already open keep the version they started with — close and
                reopen them to pick this up.
              </div>
            )}
            {failure && (
              <div
                style={{
                  color: 'var(--danger)',
                  fontFamily: MONO,
                  fontSize: 11.5,
                  marginTop: updated > 0 ? 8 : 0,
                  wordBreak: 'break-word'
                }}
              >
                {failure.message}
              </div>
            )}
          </div>
        )}

        <div style={{ flex: 'none', display: 'flex', borderTop: '1px solid var(--border-2)' }}>
          <FooterButton
            /* Only filled while there's something to install — a dimmed accent
               block still reads as the button you're meant to press. */
            primary={behind.length > 0}
            height={48}
            disabled={busy || behind.length === 0}
            onClick={() => void updateClaudeAll()}
          >
            {busy
              ? 'Updating…'
              : behind.length === 0
                ? 'Nothing to update'
                : `Update ${behind.length === 1 ? 'container' : `all ${behind.length} containers`}`}
          </FooterButton>
          <FooterButton height={48} disabled={busy} onClick={closeDialog}>
            Close
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
