import React from 'react'
import type { Project, Session } from '@shared/types'
import { useStore } from '../state/store'
import { ACCENT, SESSION_TYPES, typeLabel } from '../theme'
import { TypeIcon } from './Icons'
import { Logo } from './Logo'
import { TerminalView } from './TerminalView'

export function TerminalHost(): React.ReactElement {
  const projects = useStore((s) => s.config.projects)
  const selected = useStore((s) => s.selectedSessionId)
  const states = useStore((s) => s.states)

  // Sessions that have ever been selected keep their xterm mounted (hidden when
  // inactive) so scrollback survives switching.
  const [opened, setOpened] = React.useState<Set<string>>(new Set())
  React.useEffect(() => {
    if (selected && !opened.has(selected)) {
      setOpened((prev) => new Set(prev).add(selected))
    }
  }, [selected, opened])

  const allSessions = projects.flatMap((p) => p.sessions.map((s) => ({ project: p, session: s })))
  const existingIds = new Set(allSessions.map(({ session }) => session.id))
  // prune opened ids whose session was removed
  const toRender = allSessions.filter(({ session }) => opened.has(session.id))

  const sel = allSessions.find(({ session }) => session.id === selected)
  const running = sel ? !!states[sel.project.id]?.running : false
  const mini = sel
    ? sel.session.type === 'host-shell'
      ? 'host'
      : running
        ? 'running'
        : 'stopped'
    : ''
  // A selected agent/container session whose container is stopped shows the
  // "start the container" placeholder instead of a terminal (opening one must
  // not auto-start the container — see main/ipc.ts openSession).
  const selBlocked = !!sel && sel.session.type !== 'host-shell' && !running

  // clean up opened set when sessions disappear (avoids leaking dead views)
  React.useEffect(() => {
    setOpened((prev) => {
      const next = new Set([...prev].filter((id) => existingIds.has(id)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects])

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        background: 'var(--terminal-bg)'
      }}
    >
      {sel ? (
        <>
          {/* header */}
          <div
            style={{
              flex: 'none',
              height: 34,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '0 16px',
              background: 'var(--terminal-bg)',
              borderBottom: '1px solid var(--border-2)'
            }}
          >
            {/* the type's own glyph rather than a colored dot — it says *what*
                this session is, not just that it has a color */}
            <span
              title={typeLabel(sel.session.type)}
              style={{ flex: 'none', display: 'flex', color: ACCENT[sel.session.type] }}
            >
              <TypeIcon type={sel.session.type} size={14} />
            </span>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
              {sel.session.name}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{sel.project.name}</span>
            <div style={{ flex: 1 }} />
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-3)',
                fontFamily: "'IBM Plex Mono', monospace"
              }}
            >
              {mini}
            </span>
          </div>

          {/* terminal body — one persistent xterm per opened session */}
          {/* data-terminal-host lets the context-menu catcher detect a click
              that lands in here and re-focus the visible terminal (ContextMenu). */}
          <div data-terminal-host style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {toRender.map(({ project, session }) => {
              // Don't mount an xterm for an agent/container session whose
              // container is stopped — mounting would call openSession and
              // (before this) auto-start it. The user starts it explicitly via
              // the placeholder below. When the container starts, the view
              // mounts and opens the pty. Host shells never need a container.
              const blocked = session.type !== 'host-shell' && !states[project.id]?.running
              if (blocked) return null
              return (
                <TerminalView
                  key={session.id}
                  project={project}
                  session={session}
                  visible={session.id === selected}
                />
              )
            })}
            {selBlocked && sel && (
              <StoppedPlaceholder project={sel.project} session={sel.session} />
            )}
          </div>
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  )
}

// Shown in the terminal body when a selected agent/container session's
// container is stopped. Opening a session never auto-starts the container
// anymore (main/ipc.ts) — the user starts it explicitly from here. Once the
// container is running the parent swaps this out for the real TerminalView.
function StoppedPlaceholder({
  project,
  session
}: {
  project: Project
  session: Session
}): React.ReactElement {
  const togglePower = useStore((s) => s.togglePower)
  const [starting, setStarting] = React.useState(false)
  const kind = typeLabel(session.type).toLowerCase()

  const start = async (): Promise<void> => {
    setStarting(true)
    try {
      await togglePower(project.id) // container is stopped → this starts it
    } finally {
      setStarting(false)
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 40,
        textAlign: 'center',
        background: 'var(--terminal-bg)'
      }}
    >
      <div
        style={{
          width: 60,
          height: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 16,
          border: '1px solid var(--border)',
          background: 'var(--field-2)',
          color: ACCENT[session.type]
        }}
      >
        <TypeIcon type={session.type} size={26} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center' }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)' }}>Container stopped</div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 380, lineHeight: 1.55 }}>
          Start <b style={{ color: 'var(--text)' }}>{project.name}</b>’s container to open this{' '}
          {kind}.
        </div>
      </div>
      <button
        onClick={() => void start()}
        disabled={starting}
        style={{
          height: 34,
          padding: '0 18px',
          background: starting ? 'var(--field-2)' : 'var(--accent)',
          color: starting ? 'var(--text-3)' : '#fff',
          border: 0,
          fontSize: 13,
          fontWeight: 500,
          cursor: starting ? 'default' : 'pointer'
        }}
      >
        {starting ? 'Starting…' : 'Start container'}
      </button>
    </div>
  )
}

function EmptyState(): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        padding: 40,
        textAlign: 'center'
      }}
    >
      <Logo size={76} style={{ borderRadius: 18, boxShadow: '0 8px 44px -12px var(--accent)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
        <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '.2px', color: 'var(--text)' }}>
          Vivarium
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--text-2)', maxWidth: 360, lineHeight: 1.55 }}>
          Select a session on the left to open its terminal — or add one to a project to get
          started.
        </div>
      </div>
      {/* the three kinds with their glyphs — this doubles as the legend for the
          icons that show up in the sidebar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        {SESSION_TYPES.map((t) => (
          <span
            key={t.type}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--border)',
              padding: '3px 9px',
              fontSize: 11.5,
              color: 'var(--text-2)'
            }}
          >
            <span style={{ display: 'flex', color: t.accent }}>
              <TypeIcon type={t.type} size={13} />
            </span>
            {typeLabel(t.type)}
          </span>
        ))}
      </div>
    </div>
  )
}
