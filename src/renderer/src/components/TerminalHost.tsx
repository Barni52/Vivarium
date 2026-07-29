import React from 'react'
import type { Project, Session } from '@shared/types'
import { useStore } from '../state/store'
import { ACCENT, SESSION_TYPES, typeLabel } from '../theme'
import { TypeIcon } from './Icons'
import { Logo } from './Logo'
import { Elapsed, formatElapsed } from './Elapsed'
import { TerminalView } from './TerminalView'

// Agent turn state for the terminal header. This is the one part of the window
// you are actually looking at while an agent works, and until now the only thing
// it reported was the container's state — which the sidebar already shows.
function AgentStatus({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const live = useStore((s) => !!s.live[sessionId])
  const activity = useStore((s) => s.activity[sessionId])
  const since = useStore((s) => s.agentSince[sessionId])
  const waitingSince = useStore((s) => s.agentWaitingSince[sessionId])
  if (!live) return null // nothing is running; the state would be a leftover
  const working = activity === 'working'
  // Blocked on the user: still mid-turn, but the duration stops at the point it
  // blocked — see agentWaitingSince in the store.
  const waiting = activity === 'waiting'
  const until = waiting ? waitingSince : undefined
  return (
    <>
      <span
        // Unlike the sidebar indicators this one is never swapped out on hover,
        // so its tooltip is reachable and can carry the long phrasing.
        title={
          waiting
            ? waitingSince
              ? `Waiting for your answer since ${formatElapsed(Date.now() - waitingSince)} ago — the turn clock is paused`
              : 'Agent is waiting for your answer — the turn clock is paused'
            : since
              ? working
                ? `This turn started ${formatElapsed(Date.now() - since)} ago`
                : `Last turn finished ${formatElapsed(Date.now() - since)} ago`
              : working
                ? 'Agent is working'
                : 'Agent is idle'
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 11,
          fontFamily: "'IBM Plex Mono', monospace",
          // A waiting agent is mid-turn, so it keeps the agent hue rather than
          // dropping to the idle grey — the word is what distinguishes them.
          color: working || waiting ? ACCENT.agent : 'var(--text-3)'
        }}
      >
        {waiting ? 'waiting' : working ? 'working' : 'idle'}
        {since && (
          <>
            {/* its own element, or it merges into the same anonymous flex item as
                the word before it and only gets a gap on one side */}
            <span style={{ opacity: 0.5 }}>·</span>
            <Elapsed since={since} until={until} />
          </>
        )}
      </span>
      {/* same thin rule the title-bar chips use, so the two readings group apart */}
      <span style={{ width: 1, height: 14, background: 'var(--border)', flex: 'none' }} />
    </>
  )
}

export function TerminalHost(): React.ReactElement {
  const projects = useStore((s) => s.config.projects)
  const selected = useStore((s) => s.selectedSessionId)
  const states = useStore((s) => s.states)
  // Which sessions still have a pty. Read here because unmounting a terminal
  // destroys its scrollback, so the container probe alone must not decide it
  // (see the third clause of `toRender` below).
  const live = useStore((s) => s.live)

  const allSessions = projects.flatMap((p) => p.sessions.map((s) => ({ project: p, session: s })))

  // Which sessions get a terminal — derived, not "every session you have ever
  // clicked" (which left a project's agents dark while its container was up, so you
  // could not start one and walk away). Each mounted view opens its own pty
  // (TerminalView) and stays mounted but hidden when another is selected, so
  // scrollback survives switching.
  //
  //  • host shells need no container, so they come up at app launch;
  //  • a running container brings every one of its sessions up — on an explicit
  //    start, and at launch for a container that was already running;
  //  • a live pty outranks the probe, because unmounting runs TerminalView's
  //    cleanup and term.dispose() takes the whole 50k-line scrollback with it.
  //    `running` is a 3s `docker inspect` poll whose isRunning() reports false for
  //    *any* non-zero exit — busy daemon, WSL hiccup, unspawnable docker.exe — and
  //    one such blip used to wipe a project's terminals while the user was on
  //    another session, invisibly: PtyManager.spawn re-attaches the same pty on the
  //    remount, so the agent kept working and its TUI repainted into a buffer with
  //    no history. A live pty is the better evidence anyway (the docker exec client
  //    dies with its container). A container that really stopped ends the pty,
  //    `live` clears, and the view unmounts exactly as before.
  const toRender = allSessions.filter(
    ({ project, session }) =>
      session.type === 'host-shell' || !!states[project.id]?.running || !!live[session.id]
  )

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
      {/* header — only a selected session has one to show */}
      {sel && (
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none' }}>
            {sel.session.type === 'agent' && <AgentStatus sessionId={sel.session.id} />}
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
        </div>
      )}

      {/* Terminal body — one persistent xterm per live session. It renders even
          with nothing selected, and the empty state sits *over* it: the views in
          here are what open the ptys, so a body that only existed once something
          was selected would mean nothing ever came up on its own. Hidden views use
          visibility:hidden, which keeps their layout, so they still fit correctly
          behind the overlay. */}
      {/* data-terminal-host lets the context-menu catcher detect a click
          that lands in here and re-focus the visible terminal (ContextMenu). */}
      <div data-terminal-host style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {toRender.map(({ project, session }) => (
          // Keyed by project *and* session: a session dragged to another project has
          // to re-exec into that project's container, and the remount is what
          // reopens the pty there — it also re-captures `project` for the
          // container-output filter and the /clip paste dir. It does drop that
          // terminal's scrollback: the guard elsewhere is against an *incidental*
          // docker-probe blip, whereas a move deliberately ends that pty, and for an
          // agent `claude --resume` re-renders the conversation itself.
          <TerminalView
            key={`${project.id}:${session.id}`}
            project={project}
            session={session}
            visible={session.id === selected}
          />
        ))}
        {selBlocked && sel && <StoppedPlaceholder project={sel.project} session={sel.session} />}
        {!sel && <EmptyState />}
      </div>
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

// Shown when no session is selected. Absolutely positioned like
// StoppedPlaceholder, because the terminal body underneath it is always rendered
// now — the hidden views in there are what bring sessions live (see TerminalHost).
function EmptyState(): React.ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        padding: 40,
        textAlign: 'center',
        background: 'var(--terminal-bg)'
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
