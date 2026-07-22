import React from 'react'
import type { Project } from '@shared/types'
import { useStore, type AttentionKind } from '../state/store'
import { ACCENT } from '../theme'
import { Chevron, Folder, Plus, GitBranch, ThinkingDots } from './Icons'
import { SessionRow } from './SessionRow'

function HeaderBtn({
  title,
  color,
  onClick,
  children
}: {
  title: string
  color?: string
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
        width: 26,
        height: 26,
        border: 0,
        background: hover ? 'var(--field-2)' : 'transparent',
        color: color ?? (hover ? 'var(--text)' : 'var(--text-2)'),
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

export function ProjectRow({ project }: { project: Project }): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const expanded = useStore((s) => !!s.expanded[project.id])
  const running = useStore((s) => !!s.states[project.id]?.running)
  const branch = useStore((s) => s.branches[project.id])
  const toggle = useStore((s) => s.toggle)
  const openAddSession = useStore((s) => s.openAddSession)
  const openSettings = useStore((s) => s.openSettings)
  const togglePower = useStore((s) => s.togglePower)
  const restart = useStore((s) => s.restart)
  const requestDeleteProject = useStore((s) => s.requestDeleteProject)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const hasOutput = useStore((s) => !!s.config.sharedOutputFolder)
  const runProjectDiff = useStore((s) => s.runProjectDiff)
  // aggregate: worst outstanding attention among child agents (shown when the
  // project is collapsed, so a notification isn't hidden with its session
  // rows); a question beats finished — an agent blocked on an answer is the
  // more urgent state
  const attention = useStore((s): AttentionKind | null => {
    let worst: AttentionKind | null = null
    for (const x of project.sessions) {
      if (x.type !== 'agent') continue
      const k = s.notifications[x.id]
      if (k === 'question') return 'question'
      if (k) worst = k
    }
    return worst
  })
  const op = useStore((s) => s.containerOps[project.id])
  const opError = useStore((s) => s.containerErrors[project.id])
  // aggregate: any child agent mid-turn (same collapsed-only rule as attention)
  const hasWorking = useStore((s) =>
    project.sessions.some(
      (x) => x.type === 'agent' && s.activity[x.id] === 'working' && s.live[x.id]
    )
  )
  const projectIds = useStore((s) => s.config.projects.map((p) => p.id))
  const dropIndicator = useStore((s) =>
    s.drag?.kind === 'project' && s.dropTarget?.id === project.id ? s.dropTarget.pos : null
  )
  const setDrag = useStore((s) => s.setDrag)
  const setDropTarget = useStore((s) => s.setDropTarget)
  const reorderProjects = useStore((s) => s.reorderProjects)

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Add session',
        onSelect: () => openAddSession(project.id, new DOMRect(e.clientX, e.clientY, 0, 0))
      },
      { label: 'Project settings', onSelect: () => openSettings(project.id) },
      {
        label:
          op === 'start'
            ? 'Starting container…'
            : op === 'stop'
              ? 'Stopping container…'
              : running
                ? 'Stop container'
                : 'Start container',
        disabled: !!op,
        onSelect: () => togglePower(project.id)
      },
      {
        label: op === 'restart' ? 'Restarting container…' : 'Restart container',
        disabled: !!op,
        onSelect: () => restart(project.id)
      },
      { label: '---' },
      {
        label: hasOutput
          ? 'Write branch diff → changes.txt'
          : 'Write branch diff (set an output folder first)',
        disabled: !hasOutput,
        onSelect: () => void runProjectDiff(project.id)
      },
      { label: '---' },
      {
        label: 'Delete project',
        danger: true,
        onSelect: () => requestDeleteProject(project.id, project.name)
      }
    ])
  }

  const onDrop = (): void => {
    const st = useStore.getState()
    const d = st.drag
    const t = st.dropTarget
    if (!d || d.kind !== 'project' || !t) return
    const ids = projectIds.filter((id) => id !== d.id)
    let idx = ids.indexOf(t.id)
    if (idx < 0) return
    if (t.pos === 'after') idx += 1
    ids.splice(idx, 0, d.id)
    void reorderProjects(ids)
  }

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {/* header */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', project.id)
          setDrag({ kind: 'project', id: project.id })
        }}
        onDragOver={(e) => {
          if (useStore.getState().drag?.kind !== 'project') return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setDropTarget({ id: project.id, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
        }}
        onDrop={(e) => {
          if (useStore.getState().drag?.kind !== 'project') return
          e.preventDefault()
          onDrop()
        }}
        onDragEnd={() => {
          setDrag(null)
          setDropTarget(null)
        }}
        onContextMenu={showMenu}
        onClick={() => toggle(project.id)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 46,
          padding: '0 8px 0 10px',
          cursor: 'pointer',
          background: hover ? 'var(--row-hover)' : 'transparent',
          boxShadow:
            dropIndicator === 'before'
              ? 'inset 0 2px 0 0 var(--accent)'
              : dropIndicator === 'after'
                ? 'inset 0 -2px 0 0 var(--accent)'
                : 'none'
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-3)',
            transform: `rotate(${expanded ? 90 : 0}deg)`,
            transition: 'transform .12s'
          }}
        >
          <Chevron />
        </span>
        <span style={{ color: 'var(--text-2)', display: 'flex', alignItems: 'center' }}>
          <Folder />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.2
            }}
          >
            {project.name}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              title={project.basePath}
              style={{
                flex: '0 1 auto',
                minWidth: 0,
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 11,
                color: 'var(--text-3)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {project.basePath}
            </span>

            {branch && (
              <span
                title={`git branch: ${branch}`}
                style={{
                  flex: 'none',
                  maxWidth: '48%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  color: 'var(--accent-2)',
                  fontSize: 11,
                  overflow: 'hidden'
                }}
              >
                <GitBranch size={10} style={{ flex: 'none' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {branch}
                </span>
              </span>
            )}
          </div>
        </div>

        {!expanded && hasWorking && !attention && (
          <ThinkingDots color={ACCENT.agent} title="An agent in this project is working" />
        )}

        {!expanded && attention && (
          <span
            title={
              attention === 'question'
                ? 'An agent in this project asked a question'
                : 'An agent in this project finished'
            }
            style={{
              width: 15,
              height: 15,
              flex: 'none',
              borderRadius: '50%',
              background: attention === 'question' ? ACCENT.agent : 'var(--danger)',
              color: '#fff',
              fontSize: 10.5,
              fontWeight: 700,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {attention === 'question' ? '?' : '!'}
          </span>
        )}

        {hover ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <HeaderBtn
              title="Add session"
              onClick={(e) => {
                e.stopPropagation()
                openAddSession(project.id, (e.currentTarget as HTMLElement).getBoundingClientRect())
              }}
            >
              <Plus size={15} />
            </HeaderBtn>
          </div>
        ) : (
          /* a container is a box: rounded square (vs the circular session
             dots), green with a steady soft glow while running — no animation,
             infrastructure hums rather than thinks. Amber pulse while a
             start/stop/restart is in flight (a cold start can take minutes);
             red with the message in the tooltip when the last op failed. */
          <span
            title={
              op === 'start'
                ? 'Starting container…'
                : op === 'stop'
                  ? 'Stopping container…'
                  : op === 'restart'
                    ? 'Restarting container…'
                    : opError
                      ? `Container operation failed: ${opError}`
                      : running
                        ? 'Container running'
                        : 'Container stopped'
            }
            style={{
              width: 9,
              height: 9,
              flex: 'none',
              marginRight: 3,
              borderRadius: 2.5,
              background: op ? '#f1c21b' : opError ? 'var(--danger)' : running ? '#42be65' : 'transparent',
              border: `1.5px solid ${op ? '#f1c21b' : opError ? 'var(--danger)' : running ? '#42be65' : '#6f7a92'}`,
              boxShadow: !op && !opError && running ? '0 0 6px rgba(66,190,101,.5)' : 'none',
              animation: op ? 'vpending 1.2s ease-in-out infinite' : 'none'
            }}
          />
        )}
      </div>

      {/* sessions */}
      {expanded && (
        <div style={{ paddingLeft: 20, marginLeft: 18, borderLeft: '1px solid var(--border-2)' }}>
          {project.sessions.map((s) => (
            <SessionRow key={s.id} project={project} session={s} />
          ))}
          {project.sessions.length === 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 10px 12px 10px',
                color: 'var(--text-3)'
              }}
            >
              <span style={{ fontSize: 12.5, fontStyle: 'italic' }}>No sessions yet</span>
              <button
                onClick={(e) =>
                  openAddSession(project.id, (e.currentTarget as HTMLElement).getBoundingClientRect())
                }
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'var(--accent)',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                Add one
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
