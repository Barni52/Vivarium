import React from 'react'
import type { ChatEntry, ChatToolStatus } from '@shared/types'
import { ACCENT, CHIP, MONO } from '../../theme'
import { Elapsed } from '../Elapsed'
import { Md, clock } from './Markdown'

// The transcript is a **gutter log, not a bubble stream**: full bleed, a fixed
// left column carrying hh:mm + who is speaking, content running to the window
// edge. Every row shares a left edge — that is what makes a long turn scannable,
// and it is also the argument that keeps subagent frames *out* of here (§9.2)
// and keeps the todo strip and the turn clock where they are.

const GUTTER = 96
/** Prose measure. Everything is a notch larger than a terminal: this is a window you read in. */
const MEASURE = 940

const mono: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 12.5,
  lineHeight: 1.55
}

function Line({
  at,
  role,
  color,
  children
}: {
  at: number
  role: string
  color?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', padding: '2px 16px' }}>
      <div
        style={{
          width: GUTTER,
          flex: 'none',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          paddingRight: 14,
          paddingTop: 3,
          fontFamily: MONO,
          fontSize: 11.5,
          color: 'var(--text-3)',
          userSelect: 'none'
        }}
      >
        <span style={{ opacity: 0.6 }}>{clock(at)}</span>
        <span style={{ color: color ?? 'var(--text-3)' }}>{role}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

export interface LogHandlers {
  /** expand a clipped tool body (main holds the full text) */
  onExpand: (entryId: string) => void
  /** expand a subagent row into its own sub-log */
  onExpandTask: (toolUseId: string, agentId: string | null) => void
  /** full bodies that have already been fetched */
  bodies: Record<string, string>
  subagents: Record<string, ChatEntry[]>
  /** the one Retry, offered by a crash / timeout row and by the read banner */
  onRetry: () => void
}

export function LogRow({
  entry,
  handlers,
  depth = 0
}: {
  entry: ChatEntry
  handlers: LogHandlers
  depth?: number
}): React.ReactElement | null {
  switch (entry.kind) {
    case 'text':
      if (entry.role === 'you') {
        return (
          <div
            style={{
              borderLeft: `2px solid ${ACCENT.chat}`,
              background: 'var(--field)',
              margin: '12px 0'
            }}
          >
            <Line at={entry.at} role="you" color={ACCENT.chat}>
              {entry.md && (
                <div
                  style={{
                    fontSize: 14,
                    lineHeight: 1.62,
                    color: 'var(--text)',
                    padding: '5px 0',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {entry.md}
                </div>
              )}
              {entry.chips && entry.chips.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 14,
                    flexWrap: 'wrap',
                    padding: '0 0 7px',
                    fontFamily: MONO,
                    fontSize: 12
                  }}
                >
                  {entry.chips.map((c, i) => (
                    <span key={`${c.name}-${i}`} style={{ color: 'var(--text-3)' }} title={c.detail}>
                      {c.kind === 'image' ? '▣' : c.kind === 'path' ? '≡' : '⌘'} {c.name}
                    </span>
                  ))}
                </div>
              )}
            </Line>
          </div>
        )
      }
      return (
        <Line at={entry.at} role="claude">
          <div style={{ maxWidth: MEASURE, paddingBottom: 5 }}>
            <Md src={entry.md} size={14} />
          </div>
        </Line>
      )

    case 'thinking':
      return <Collapsible at={entry.at} role="think" md={entry.md} />

    case 'tool':
      return <ToolCard entry={entry} handlers={handlers} />

    case 'cmd':
      // Open and truncated like an edit body — a context table is exactly what
      // you asked to see. `Unknown command: /x` lands here too: it is a reply,
      // not an error.
      return (
        <Line at={entry.at} role="cmd" color={CHIP.model}>
          <div style={{ maxWidth: MEASURE, padding: '2px 0 6px' }}>
            {entry.title && (
              <div style={{ ...mono, color: 'var(--text)' }}>{entry.title}</div>
            )}
            <Md src={entry.md} size={13.5} />
            {entry.truncated && (
              <div style={{ ...mono, color: 'var(--text-3)', opacity: 0.7 }}>…</div>
            )}
          </div>
        </Line>
      )

    case 'ask':
      // Once answered the chosen option keeps a tick while the rest go grey: the
      // options not taken are the record of what the decision was between.
      return (
        <Line at={entry.at} role="ask" color={CHIP.plan}>
          <div style={{ padding: '5px 0 9px', maxWidth: MEASURE }}>
            {entry.questions.map((q, qi) => (
              <div key={qi} style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 13.5, color: 'var(--text)', marginBottom: 7 }}>
                  {q.question}
                </div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {q.options.map((o) => {
                    const picked = entry.answers.includes(o.label)
                    return (
                      <span
                        key={o.label}
                        title={o.description}
                        style={{
                          fontFamily: MONO,
                          fontSize: 12,
                          padding: '4px 10px',
                          border: `1px solid ${picked ? ACCENT.chat : 'var(--border)'}`,
                          color: picked ? 'var(--text)' : 'var(--text-3)',
                          background: picked ? 'rgba(192,139,184,.09)' : 'transparent'
                        }}
                      >
                        {picked ? '✓ ' : ''}
                        {o.label}
                      </span>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </Line>
      )

    case 'plan':
      // The body renders here, in its place in time, so the transcript stays a
      // complete record; the *buttons* are pinned above the composer, so a
      // decision cannot scroll away behind twenty tool calls.
      return (
        <Line at={entry.at} role="plan" color={CHIP.plan}>
          <div
            style={{
              maxWidth: MEASURE,
              border: '1px solid var(--border)',
              borderLeft: `2px solid ${CHIP.plan}`,
              padding: '3px 15px 11px',
              margin: '7px 0',
              opacity: entry.state === 'cancelled' ? 0.75 : 1
            }}
          >
            <Md src={entry.md} size={14} />
            {entry.state !== 'pending' && (
              <div style={{ ...mono, color: 'var(--text-3)' }}>{entry.state}</div>
            )}
          </div>
        </Line>
      )

    case 'task':
      return <TaskRow entry={entry} handlers={handlers} depth={depth} />

    case 'todo':
      // Always one line — the second exception to open-by-default. It changed
      // nothing on disk; the *fold* is the strip above the composer.
      return (
        <Line at={entry.at} role="todo">
          <div style={{ ...mono, color: 'var(--text-3)', padding: '2px 0' }}>{entry.text}</div>
        </Line>
      )

    case 'stop':
      // Muted for an interrupt, red for a crash. Colour in this chrome means
      // *attend to this*; an interrupt is something the user just did, so it
      // earns a role word and nothing more.
      return (
        <Line at={entry.at} role="stop" color={entry.tone === 'alert' ? 'var(--danger)' : undefined}>
          <div
            style={{
              ...mono,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              color: entry.tone === 'alert' ? 'var(--danger)' : 'var(--text-3)',
              padding: '6px 0'
            }}
          >
            {entry.text}
            {entry.retry && (
              // Never automatic: a respawn costs a process and a 14.6 MB-class
              // transcript read, and a crash loop that retried itself would be
              // invisible. The 60s-timeout row especially — a genuinely wedged
              // CLI would otherwise be respawned every minute all day.
              <button
                onClick={handlers.onRetry}
                style={{
                  ...mono,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text-2)',
                  padding: '2px 10px',
                  cursor: 'pointer'
                }}
              >
                Retry
              </button>
            )}
          </div>
        </Line>
      )

    case 'divider':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px 12px' }}>
          <span style={{ flex: 'none', width: GUTTER - 14 }} />
          <span style={{ ...mono, color: 'var(--text-3)', flex: 'none' }}>{entry.text}</span>
          <span style={{ flex: 1, height: 1, background: 'var(--border-2)' }} />
        </div>
      )

    case 'turn':
      // The turn clock, in the log where the eye already is — live while the turn
      // runs, frozen in place at `result`. Not a header chip: #5 enumerated the
      // header's three items without it, and a separate activity lane was the
      // thing variant B lost on.
      return (
        <Line at={entry.at} role="run" color={ACCENT.chat}>
          <div
            style={{
              ...mono,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              color: 'var(--text-3)',
              padding: '3px 0'
            }}
          >
            {entry.durationMs === undefined ? (
              <>
                <Dots />
                <span>working ·</span>
                <Elapsed since={entry.startedAt} />
                {/* Discoverability for interrupt, on screen exactly when it is
                    usable and nowhere else. */}
                <span style={{ opacity: 0.65 }}>· esc interrupts</span>
              </>
            ) : (
              <span>
                done · <Elapsed since={0} until={entry.durationMs} />
              </span>
            )}
          </div>
        </Line>
      )
  }
}

/** Three-dot working indicator, reusing the app's existing vthink keyframes. */
export function Dots({ color = ACCENT.chat }: { color?: string }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {[0, 1, 2].map((n) => (
        <span
          key={n}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: color,
            animation: `vthink 1.1s ${n * 0.16}s infinite ease-in-out`
          }}
        />
      ))}
    </span>
  )
}

/** A `think` row: collapsed to its first line, because that is usually enough. */
function Collapsible({ at, role, md }: { at: number; role: string; md: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const first = md.trim().split('\n')[0] ?? ''
  return (
    <Line at={at} role={role}>
      <div style={{ padding: '2px 0', maxWidth: MEASURE }}>
        <button
          onClick={() => setOpen(!open)}
          style={{
            display: 'flex',
            gap: 10,
            border: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
            color: 'var(--text-3)',
            fontSize: 13,
            fontStyle: 'italic',
            maxWidth: '100%'
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {first}
          </span>
          <span style={{ ...mono, fontSize: 11, opacity: 0.7, flex: 'none' }}>
            {open ? '▾ hide' : '▸ show'}
          </span>
        </button>
        {open && <Md src={md} size={13} />}
      </div>
    </Line>
  )
}

function statusColor(status: ChatToolStatus): string {
  if (status === 'error') return 'var(--danger)'
  return 'var(--text-3)'
}

/**
 * **Open by default and truncated — inverted from the obvious default.** An edit
 * shows its diff and a command shows the tail of its output; a read and a search
 * collapse to their gutter line. A read changed nothing; a diff is what you
 * scrolled back for. Collapse-everything was rejected for making the common case
 * a click.
 */
function ToolCard({
  entry,
  handlers
}: {
  entry: Extract<ChatEntry, { kind: 'tool' }>
  handlers: LogHandlers
}): React.ReactElement {
  const quiet =
    entry.role === 'read' ||
    entry.body.kind === 'none' ||
    // A cancelled card collapses: its synthetic result carries only the refusal
    // sentence, so an open card would be a card showing nothing.
    entry.status === 'cancelled'
  const [open, setOpen] = React.useState(!quiet)
  const full = handlers.bodies[entry.id]
  const text = full ?? entry.body.text

  const toggle = (): void => {
    if (!open && entry.body.truncated) handlers.onExpand(entry.id)
    setOpen(!open)
  }

  return (
    <Line at={entry.at} role={entry.role}>
      <div style={{ padding: '2px 0' }}>
        <button
          onClick={toggle}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            border: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
            maxWidth: '100%'
          }}
        >
          <span
            style={{
              ...mono,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {entry.title}
          </span>
          {entry.status === 'running' ? (
            <>
              <Dots />
              {/* A tool running past ~2s shows a number, so a fast Read never
                  flickers one. */}
              <SlowClock since={entry.at} />
            </>
          ) : (
            <span style={{ ...mono, color: statusColor(entry.status), flex: 'none' }}>
              {entry.result}
            </span>
          )}
          {entry.body.kind !== 'none' && entry.body.text && (
            <span style={{ ...mono, fontSize: 11, color: 'var(--text-3)', opacity: 0.7, flex: 'none' }}>
              {open ? '▾ hide' : '▸ show'}
            </span>
          )}
        </button>

        {open && entry.body.kind === 'diff' && (
          <div
            style={{
              ...mono,
              margin: '5px 0 9px',
              border: '1px solid var(--border-2)',
              maxWidth: MEASURE,
              overflowX: 'auto'
            }}
          >
            {text.split('\n').map((l, i) => (
              <div
                key={i}
                style={{
                  whiteSpace: 'pre',
                  background:
                    l.startsWith('+')
                      ? 'rgba(89,168,164,.13)'
                      : l.startsWith('-')
                        ? 'rgba(250,77,86,.11)'
                        : 'transparent',
                  color: l.startsWith('+') || l.startsWith('-') ? 'var(--text)' : 'var(--text-3)',
                  padding: '0 9px'
                }}
              >
                {l || ' '}
              </div>
            ))}
            {entry.body.truncated && !full && (
              <div style={{ padding: '2px 9px', color: 'var(--text-3)' }}>…</div>
            )}
          </div>
        )}

        {open && entry.body.kind === 'text' && (
          <div
            style={{
              ...mono,
              margin: '5px 0 9px',
              color: 'var(--text-3)',
              whiteSpace: 'pre-wrap',
              maxWidth: MEASURE,
              overflowX: 'auto'
            }}
          >
            {text}
          </div>
        )}
      </div>
    </Line>
  )
}

/** A duration that appears only once the call is genuinely slow. */
function SlowClock({ since }: { since: number }): React.ReactElement | null {
  const [show, setShow] = React.useState(Date.now() - since > 2000)
  React.useEffect(() => {
    if (show) return
    const t = setTimeout(() => setShow(true), 2000)
    return () => clearTimeout(t)
  }, [show])
  if (!show) return null
  return <Elapsed since={since} style={{ ...mono, color: 'var(--text-3)' }} />
}

/**
 * One `task` row that expands into its own sub-log.
 *
 * The filesystem hands us exactly this shape, which is the reason to trust it:
 * the parent transcript already *is* the collapsed view, and the sibling file
 * already *is* the expansion. The sub-log nests — a subagent's own subagent is
 * another task row that expands the same way, with no depth cap.
 */
function TaskRow({
  entry,
  handlers,
  depth
}: {
  entry: Extract<ChatEntry, { kind: 'task' }>
  handlers: LogHandlers
  depth: number
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const sub = handlers.subagents[entry.toolUseId] ?? []

  const toggle = (): void => {
    if (!open) handlers.onExpandTask(entry.toolUseId, entry.agentId)
    setOpen(!open)
  }

  const stats = [
    entry.status,
    entry.durationMs !== null ? `${Math.round(entry.durationMs / 1000)}s` : null,
    entry.tools !== null ? `${entry.tools} tools` : null,
    entry.tokens !== null ? `${Math.round(entry.tokens / 100) / 10}k tok` : null
  ].filter(Boolean)

  return (
    <>
      <Line at={entry.at} role="task" color={CHIP.model}>
        <div style={{ padding: '2px 0' }}>
          <div style={{ ...mono, color: 'var(--text)' }}>
            {entry.agentType} · {entry.description}
          </div>
          <div style={{ ...mono, color: 'var(--text-3)', display: 'flex', gap: 9 }}>
            {entry.running ? (
              <>
                <Dots />
                <Elapsed since={entry.at} />
              </>
            ) : (
              <span>{stats.join(' · ')}</span>
            )}
            <button
              onClick={toggle}
              style={{
                ...mono,
                fontSize: 11,
                border: 0,
                background: 'transparent',
                color: 'var(--text-3)',
                opacity: 0.75,
                padding: 0,
                cursor: 'pointer'
              }}
            >
              {open ? '▾ hide' : `▸ show${sub.length ? ` ${sub.length} steps` : ''}`}
            </button>
          </div>
        </div>
      </Line>
      {open && (
        <div style={{ borderLeft: '1px solid var(--border-2)', marginLeft: GUTTER + 22 }}>
          {sub.map((e) => (
            <LogRow key={e.id} entry={e} handlers={handlers} depth={depth + 1} />
          ))}
          {sub.length === 0 && (
            <div style={{ ...mono, color: 'var(--text-3)', padding: '4px 16px' }}>
              no steps recorded
            </div>
          )}
        </div>
      )}
    </>
  )
}
