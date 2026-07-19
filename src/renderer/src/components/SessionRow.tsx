import React from 'react'
import type { Project, Session } from '@shared/types'
import { useStore } from '../state/store'
import { ACCENT } from '../theme'
import { TypeIcon, Pencil, Close } from './Icons'

export function SessionRow({ project, session }: { project: Project; session: Session }): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const selectedId = useStore((s) => s.selectedSessionId)
  const editingId = useStore((s) => s.editingSessionId)
  const editDraft = useStore((s) => s.editDraft)
  const live = useStore((s) => !!s.live[session.id])
  const activity = useStore((s) => s.activity[session.id])
  const notified = useStore((s) => !!s.notifications[session.id])
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

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', onSelect: () => startRename(session.id, session.name) },
      { label: '---' },
      {
        label: 'Kill session',
        danger: true,
        onSelect: () => requestKill(project.id, session.id, session.name)
      }
    ])
  }

  const onDrop = (): void => {
    const st = useStore.getState()
    const d = st.drag
    const t = st.dropTarget
    if (!d || d.kind !== 'session' || d.projectId !== project.id || !t) return
    const ids = project.sessions.map((s) => s.id).filter((id) => id !== d.id)
    let idx = ids.indexOf(t.id)
    if (idx < 0) return
    if (t.pos === 'after') idx += 1
    ids.splice(idx, 0, d.id)
    void reorderSessions(project.id, ids)
  }

  const selected = session.id === selectedId
  const editing = session.id === editingId
  const isAgent = session.type === 'agent'
  const accent = ACCENT[session.type]
  const working = isAgent && activity === 'working' && live

  const bg = selected ? 'var(--sel)' : hover ? 'var(--row-hover)' : 'transparent'
  const nameColor = selected ? 'var(--text)' : 'var(--text-2)'

  // state dot (shown when not hovering / not editing)
  let dotBg = 'transparent'
  let dotBorder = '#6f7a92'
  let dotAnim = 'none'
  let dotTitle = ''
  if (isAgent) {
    dotTitle = working ? 'Agent working' : 'Agent idle'
    if (working) {
      dotBg = '#42be65'
      dotBorder = '#42be65'
      dotAnim = 'vpulse 1.8s infinite'
    }
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
      onDragOver={(e) => {
        const d = useStore.getState().drag
        if (d?.kind !== 'session' || d.projectId !== project.id) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        setDropTarget({ id: session.id, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
      }}
      onDrop={(e) => {
        const d = useStore.getState().drag
        if (d?.kind !== 'session' || d.projectId !== project.id) return
        e.preventDefault()
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

      {!hover && !editing && notified && (
        <span
          title="Agent finished — click to view"
          style={{
            width: 16,
            height: 16,
            flex: 'none',
            marginRight: 1,
            borderRadius: '50%',
            background: 'var(--danger)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          !
        </span>
      )}

      {!hover && !editing && !notified && (
        <span
          title={dotTitle}
          style={{
            width: 7,
            height: 7,
            flex: 'none',
            marginRight: 2,
            borderRadius: '50%',
            background: dotBg,
            border: `1.5px solid ${dotBorder}`,
            animation: dotAnim
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
