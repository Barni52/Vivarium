import React from 'react'
import type { SessionType } from '@shared/types'
import { useStore, defaultSessionName } from '../../state/store'
import { ADD_SESSION_POPOVER, SESSION_TYPES, typeLabel, type SessionTypeMeta } from '../../theme'
import { TypeIcon } from '../Icons'

// New-session picker.
//
// Three things made the old version easy to misclick: the two shell rows used
// the *same* terminal glyph (color was the only difference), their titles both
// started with "Terminal · ", and the container one sat above the host one —
// which is the one that gets picked nearly every time. So this version leans on
// the differences instead of the similarities:
//
//   - one distinct silhouette per type (star / window / cube), no color needed
//   - one-word titles under a shared "Terminal" heading, host first
//   - the shell that actually runs, in mono, right under the title
//   - the Create button names what it will create, so a wrong row is caught
//     before it costs a session
//   - the last type you created is preselected, so the common case is Enter
//
// Colors are the muted ACCENT palette (see theme.ts) — the tinted icon tiles
// this used to have were the loudest thing in the app.

function Row({
  meta,
  selected,
  subtitle,
  onPick
}: {
  meta: SessionTypeMeta
  selected: boolean
  subtitle: React.ReactNode
  onPick: () => void
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)

  return (
    <button
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={typeLabel(meta.type)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        width: '100%',
        height: 50,
        padding: '0 16px',
        border: 0,
        background: selected ? 'var(--sel)' : hover ? 'var(--row-hover)' : 'transparent',
        // same selection bar the sidebar uses for the active session, a touch
        // heavier here — which row is armed is the one thing you must not
        // misread before pressing Create
        boxShadow: selected ? `inset 3px 0 0 ${meta.accent}` : 'none',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 5,
          border: `1px solid ${selected ? meta.accent : 'var(--border)'}`,
          background: selected ? 'var(--field-2)' : 'var(--field)',
          color: meta.accent
        }}
      >
        <TypeIcon type={meta.type} size={16} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: selected ? 'var(--text)' : 'var(--text-2)',
            lineHeight: 1.1
          }}
        >
          {meta.title}
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-3)',
            fontFamily: "'IBM Plex Mono', monospace",
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {subtitle}
        </span>
      </span>
    </button>
  )
}

export function AddSessionPopover(): React.ReactElement | null {
  const draft = useStore((s) => s.addSession)
  const setAddSession = useStore((s) => s.setAddSession)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirm = useStore((s) => s.confirmAddSession)
  const project = useStore((s) => s.config.projects.find((p) => p.id === draft?.projectId))
  // Switching type re-derives the name (agent-1 → ps-host-1), but not once the
  // name has been typed in — losing what you wrote is its own small betrayal.
  const [named, setNamed] = React.useState(false)
  const [nameFocus, setNameFocus] = React.useState(false)

  if (!draft) return null

  const pick = (type: SessionType): void => {
    setAddSession(named ? { type } : { type, name: defaultSessionName(project, type) })
  }

  // ↑/↓ walk the three rows so the whole flow works from the keyboard: the
  // popover opens with the last type preselected and the name field focused,
  // which makes the common case a single Enter.
  const step = (delta: number): void => {
    const i = SESSION_TYPES.findIndex((t) => t.type === draft.type)
    const next = SESSION_TYPES[(i + delta + SESSION_TYPES.length) % SESSION_TYPES.length]
    pick(next.type)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      step(e.key === 'ArrowDown' ? 1 : -1)
    }
    if (e.key === 'Enter') void confirm()
    // Escape closes this one (unlike the modal dialogs) — it's a popover, and
    // clicking anywhere outside already dismisses it.
    if (e.key === 'Escape') closeDialog()
  }

  const subtitleFor = (type: SessionType): React.ReactNode => {
    const meta = SESSION_TYPES.find((t) => t.type === type)
    if (!meta) return null
    // The host row says *which folder* — "on Windows" is true but abstract, and
    // the path is the thing you actually care about when you open a shell.
    const where = type === 'host-shell' && project?.basePath ? project.basePath : meta.where
    return (
      <>
        <span style={{ color: 'var(--text-2)' }}>{meta.shell}</span>
        {` · ${where}`}
      </>
    )
  }

  return (
    <div onClick={closeDialog} style={{ position: 'absolute', inset: 0, zIndex: 45 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          position: 'absolute',
          top: draft.top,
          left: draft.left,
          width: ADD_SESSION_POPOVER.width,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          boxShadow: '0 18px 44px -16px rgba(0,0,0,.7)',
          animation: 'vpop .13s ease',
          paddingBottom: 2
        }}
      >
        <div
          style={{
            padding: '13px 16px 10px 16px',
            fontSize: 12,
            color: 'var(--text-3)',
            display: 'flex',
            alignItems: 'baseline',
            gap: 6
          }}
        >
          New session in
          <span
            style={{
              color: 'var(--text-2)',
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {project?.name}
          </span>
        </div>

        {SESSION_TYPES.map((meta, i) => (
          <React.Fragment key={meta.type}>
            {/* group heading: carries the word "terminal" so the rows below it
                don't have to, leaving one distinct word each */}
            {meta.group && meta.group !== SESSION_TYPES[i - 1]?.group && (
              <div
                style={{
                  margin: '8px 0 0 0',
                  padding: '9px 16px 4px 16px',
                  borderTop: '1px solid var(--border-2)',
                  fontSize: 10.5,
                  letterSpacing: '.7px',
                  textTransform: 'uppercase',
                  color: 'var(--text-3)'
                }}
              >
                {meta.group}
              </div>
            )}
            <Row
              meta={meta}
              selected={draft.type === meta.type}
              subtitle={subtitleFor(meta.type)}
              onPick={() => pick(meta.type)}
            />
          </React.Fragment>
        ))}

        <div style={{ padding: '14px 16px 0 16px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 6 }}>
            <label style={{ fontSize: 12, color: 'var(--text-2)', flex: 1 }}>Name</label>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>↵ creates</span>
          </div>
          <input
            value={draft.name}
            autoFocus
            onChange={(e) => {
              setNamed(true)
              setAddSession({ name: e.target.value })
            }}
            onFocus={() => setNameFocus(true)}
            onBlur={() => setNameFocus(false)}
            style={{
              width: '100%',
              height: 34,
              background: 'var(--field)',
              border: '1px solid',
              borderColor: nameFocus ? 'var(--accent)' : 'var(--border)',
              color: 'var(--text)',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 13,
              padding: '0 10px',
              outline: 'none'
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '14px 16px 16px 16px' }}>
          {/* Names the type it will create: the last chance to notice a row was
              clicked by mistake, which is cheaper than killing a session. */}
          <button
            onClick={() => void confirm()}
            style={{
              flex: 1,
              height: 36,
              border: 0,
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            Create {typeLabel(draft.type).toLowerCase()}
          </button>
          <button
            onClick={closeDialog}
            style={{
              width: 84,
              flex: 'none',
              height: 36,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-2)',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
