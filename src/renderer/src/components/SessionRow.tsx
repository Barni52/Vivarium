import React from 'react'
import type { Project, Session } from '@shared/types'
import { useStore } from '../state/store'
import { ACCENT, MONO } from '../theme'
import { TypeIcon, Pencil, Close, ThinkingDots } from './Icons'
import { Elapsed } from './Elapsed'

// Turn duration next to an agent's indicator. Deliberately visible text, not a
// tooltip: both indicators only render while the row is NOT hovered (the hover
// controls take their place), so a title on them could never be read.
const durationStyle: React.CSSProperties = {
  flex: 'none',
  fontFamily: MONO,
  fontSize: 10.5,
  color: 'var(--text-3)'
}

export function SessionRow({ project, session }: { project: Project; session: Session }): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const selectedId = useStore((s) => s.selectedSessionId)
  const editingId = useStore((s) => s.editingSessionId)
  const editDraft = useStore((s) => s.editDraft)
  const live = useStore((s) => !!s.live[session.id])
  const activity = useStore((s) => s.activity[session.id])
  const attention = useStore((s) => s.notifications[session.id])
  const since = useStore((s) => s.agentSince[session.id])
  const waitingSince = useStore((s) => s.agentWaitingSince[session.id])
  const select = useStore((s) => s.select)
  const startRename = useStore((s) => s.startRename)
  const setEditDraft = useStore((s) => s.setEditDraft)
  const commitRename = useStore((s) => s.commitRename)
  const cancelRename = useStore((s) => s.cancelRename)
  const requestKill = useStore((s) => s.requestKill)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const dropIndicator = useStore((s) =>
    s.drag?.kind === 'session' && s.dropTarget?.id === session.id ? s.dropTarget.pos : null
  )
  const setDrag = useStore((s) => s.setDrag)
  const setDropTarget = useStore((s) => s.setDropTarget)
  const reorderSessions = useStore((s) => s.reorderSessions)
  const requestMoveSession = useStore((s) => s.requestMoveSession)

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Rename',
        icon: <Pencil size={13} />,
        onSelect: () => startRename(session.id, session.name)
      },
      { label: '---' },
      {
        // same two glyphs as this row's hover controls, so the menu and the
        // buttons it duplicates can't disagree
        label: 'Kill session',
        icon: <Close size={13} />,
        danger: true,
        onSelect: () => requestKill(project.id, session.id, session.name)
      }
    ])
  }

  const onDrop = (): void => {
    const st = useStore.getState()
    const d = st.drag
    const t = st.dropTarget
    if (!d || d.kind !== 'session' || !t || t.id !== session.id) return

    // A session from another project: same insertion arithmetic, but the dragged
    // id isn't in this list to filter out, and it goes through the move path
    // (which confirms first, because it ends the session's pty).
    if (d.projectId && d.projectId !== project.id) {
      let idx = project.sessions.findIndex((s) => s.id === t.id)
      if (idx < 0) return
      if (t.pos === 'after') idx += 1
      requestMoveSession(d.projectId, project.id, d.id, idx)
      return
    }

    const ids = project.sessions.map((s) => s.id).filter((id) => id !== d.id)
    let idx = ids.indexOf(t.id)
    if (idx < 0) return
    if (t.pos === 'after') idx += 1
    ids.splice(idx, 0, d.id)
    void reorderSessions(project.id, ids)
  }

  const selected = session.id === selectedId
  const editing = session.id === editingId
  // Both agent kinds: a chat is an agent session, spoken to rather than typed at,
  // and it reports the same working/waiting/idle triple from the same channel.
  const isAgent = session.type === 'agent' || session.type === 'chat'
  const accent = ACCENT[session.type]
  const working = isAgent && activity === 'working' && live
  // Mid-turn but blocked on the user (a question, or a plan waiting for
  // approval). Deliberately not folded into `working`: it is the state where the
  // agent is doing nothing at all, and the row has to say so.
  const waiting = isAgent && activity === 'waiting' && live

  // The badge, if any — one indicator, decided in priority order so the three
  // possible readings can never render two glyphs. An outstanding flag wins over
  // the live state (it is the thing you haven't seen yet), and a waiting agent
  // shows the same "?" whether or not it was flagged: one you are watching is
  // still one that is waiting for you.
  let badge: { glyph: string; color: string; title: string } | null = null
  if (isAgent && attention === 'finished') {
    badge = { glyph: '!', color: 'var(--danger)', title: 'Agent finished — click to view' }
  } else if (isAgent && (waiting || attention === 'question')) {
    badge = {
      glyph: '?',
      color: accent,
      title: 'Agent is waiting for you — click to answer'
    }
  }
  // Held at the point the agent blocked, so the row reports the work this turn
  // has done rather than how long you have been away from your desk.
  const until = waiting ? waitingSince : undefined

  const bg = selected ? 'var(--sel)' : hover ? 'var(--row-hover)' : 'transparent'
  const nameColor = selected ? 'var(--text)' : 'var(--text-2)'

  // state dot (shown when not hovering / not editing)
  // A working agent doesn't use this dot at all — it renders ThinkingDots in
  // the agent accent instead, so "agent busy" (violet ellipsis) and "container
  // up" (green square on the project header) can't be mistaken for each other.
  let dotBorder = '#6f7a92'
  let dotTitle = ''
  if (isAgent) {
    dotTitle = 'Agent idle'
  } else {
    dotTitle = live ? 'Session live' : 'Session idle'
    dotBorder = live ? '#42be65' : '#6f7a92'
  }

  const selBar = `inset 2px 0 0 ${selected ? 'var(--accent)' : 'transparent'}`
  const dropShadow =
    dropIndicator === 'before'
      ? 'inset 0 2px 0 0 var(--accent)'
      : dropIndicator === 'after'
        ? 'inset 0 -2px 0 0 var(--accent)'
        : ''

  return (
    <div
      draggable={!editing}
      onDragStart={(e) => {
        e.stopPropagation()
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', session.id)
        setDrag({ kind: 'session', id: session.id, projectId: project.id })
      }}
      // Any session drag is welcome here, not just one from this project — a row
      // is how you land a session at a chosen position in another project. The
      // dragged row itself is skipped so it can't target itself.
      onDragOver={(e) => {
        const d = useStore.getState().drag
        if (d?.kind !== 'session' || d.id === session.id) return
        e.preventDefault()
        // The enclosing sessions container also accepts session drags (it is the
        // "append to this project" surface). Keep this row's precise before/after
        // target from being overwritten by it as the event bubbles.
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        setDropTarget({ id: session.id, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
      }}
      onDrop={(e) => {
        const d = useStore.getState().drag
        if (d?.kind !== 'session' || d.id === session.id) return
        e.preventDefault()
        e.stopPropagation() // ditto — or the container would move it a second time
        onDrop()
      }}
      onDragEnd={() => {
        setDrag(null)
        setDropTarget(null)
      }}
      onContextMenu={showMenu}
      onClick={() => select(session.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 31,
        padding: '0 8px 0 10px',
        cursor: 'pointer',
        background: bg,
        boxShadow: dropShadow ? `${selBar}, ${dropShadow}` : selBar
      }}
    >
      <span
        style={{ width: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: accent }}
      >
        <TypeIcon type={session.type} />
      </span>

      {editing ? (
        <input
          value={editDraft}
          autoFocus
          onChange={(e) => setEditDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => commitRename(project.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(project.id)
            if (e.key === 'Escape') cancelRename()
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--field)',
            border: '1px solid var(--accent)',
            color: 'var(--text)',
            fontSize: 13,
            height: 24,
            padding: '0 6px',
            outline: 'none'
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            fontSize: 13,
            color: nameColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {session.name}
        </span>
      )}

      {hover && !editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <RowBtn
            title="Rename"
            onClick={(e) => {
              e.stopPropagation()
              startRename(session.id, session.name)
            }}
          >
            <Pencil />
          </RowBtn>
          <RowBtn
            title="Kill session"
            danger
            onClick={(e) => {
              e.stopPropagation()
              requestKill(project.id, session.id, session.name)
            }}
          >
            <Close />
          </RowBtn>
        </div>
      )}

      {/* Next to a "!", how stale the flag is — one you left sitting for an hour
          means something different from one raised ten seconds ago. Next to a
          working or waiting agent, this turn's duration. */}
      {!hover && !editing && isAgent && since && (badge || working) && (
        <Elapsed since={since} until={until} style={durationStyle} />
      )}

      {!hover && !editing && badge && (
        /* "?" in the agent accent = blocked on the user (urgent — the whole turn
           waits); red "!" = turn finished */
        <span
          title={badge.title}
          style={{
            width: 16,
            height: 16,
            flex: 'none',
            marginRight: 1,
            borderRadius: '50%',
            background: badge.color,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {badge.glyph}
        </span>
      )}

      {!hover && !editing && isAgent && !badge && working && (
        <ThinkingDots color={accent} title="Agent working" style={{ marginRight: 2 }} />
      )}

      {!hover && !editing && isAgent && !badge && !working && (
        <span
          title={dotTitle}
          style={{
            width: 7,
            height: 7,
            flex: 'none',
            marginRight: 2,
            borderRadius: '50%',
            border: `1.5px solid ${dotBorder}`
          }}
        />
      )}
    </div>
  )
}

function RowBtn({
  title,
  danger,
  onClick,
  children
}: {
  title: string
  danger?: boolean
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24,
        height: 24,
        border: 0,
        background: hover ? (danger ? 'rgba(250,77,86,.14)' : 'var(--field-2)') : 'transparent',
        color: hover ? (danger ? 'var(--danger)' : 'var(--text)') : 'var(--text-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}
