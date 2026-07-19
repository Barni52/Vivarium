import React from 'react'
import { useStore } from '../state/store'
import { ACCENT } from '../theme'
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
            <span
              style={{
                width: 8,
                height: 8,
                flex: 'none',
                borderRadius: '50%',
                background: ACCENT[sel.session.type]
              }}
            />
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
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {toRender.map(({ project, session }) => (
              <TerminalView
                key={session.id}
                project={project}
                session={session}
                visible={session.id === selected}
              />
            ))}
          </div>
        </>
      ) : (
        <EmptyState />
      )}
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
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginTop: 4,
          fontSize: 12,
          color: 'var(--text-3)',
          fontFamily: "'IBM Plex Mono', monospace"
        }}
      >
        {['Agent', 'Terminal · container', 'Terminal · host'].map((t) => (
          <span key={t} style={{ border: '1px solid var(--border)', padding: '2px 8px' }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}
