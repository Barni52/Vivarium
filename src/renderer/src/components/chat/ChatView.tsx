import React from 'react'
import type {
  ChatAnswer,
  ChatBlockingCard,
  ChatEntry,
  ChatMode,
  ChatTodo,
  MountNode,
  Project,
  Session
} from '@shared/types'
import { useStore } from '../../state/store'
import { ACCENT, CHIP, MONO, ctxColor } from '../../theme'
import { ChatBubble } from '../Icons'
import { LogRow, type LogHandlers } from './ChatLog'
import { chipForNode, flattenTree, routeFile, type PendingChip } from './attach'

// Variant D: **C's log body inside A's chrome** — a gutter log you can scan,
// under a proper session header, over a composer that is only a box.
//
// The composer has no attach button, no `⏎ send` hint and no Send or Interrupt
// button, because every affordance has a home that costs no chrome: Enter sends,
// Esc interrupts (taught on the live working row, on screen exactly when it is
// usable), Ctrl+V and drag-drop attach, and two typeaheads live inside the box —
// `@` anywhere over the mounted tree, `/` at position 0 only.

export function ChatView({
  project,
  session,
  visible
}: {
  project: Project
  session: Session
  visible: boolean
}): React.ReactElement {
  const chat = useStore((s) => s.chats[session.id])
  const running = useStore((s) => !!s.states[project.id]?.running)
  const openChat = useStore((s) => s.openChat)
  const closeChat = useStore((s) => s.closeChat)
  const sendChat = useStore((s) => s.sendChat)
  const interruptChat = useStore((s) => s.interruptChat)
  const answerChat = useStore((s) => s.answerChat)
  const setChatMode = useStore((s) => s.setChatMode)
  const setChatModel = useStore((s) => s.setChatModel)
  const loadEarlier = useStore((s) => s.loadEarlier)
  const loadBody = useStore((s) => s.loadBody)
  const loadSubagent = useStore((s) => s.loadSubagent)

  // Draft and pending chips live here, not in the store: they are meant to die
  // with the view. A cross-project move remounts this component (TerminalHost
  // keys on project:session), and buying a half-written message the right to
  // outlive a deliberate destructive act is not worth state that has to survive a
  // remount. The confirm dialog says so.
  const [draft, setDraft] = React.useState('')
  const [chips, setChips] = React.useState<PendingChip[]>([])
  const [tree, setTree] = React.useState<MountNode[]>([])
  const [focus, setFocus] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [menu, setMenu] = React.useState<null | { kind: 'slash' | 'at'; query: string }>(null)
  const [models, setModels] = React.useState<string[] | null>(null)
  const [modelMenu, setModelMenu] = React.useState(false)

  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const logRef = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)

  // Eager open, at container start, alongside terminal sessions — a session is
  // live whenever it can be, not when it was last clicked. The first message is
  // then answered with no cold-start wait.
  React.useEffect(() => {
    if (!running) return
    void openChat(project.id, session.id)
    return () => closeChat(session.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, project.id, session.id])

  // Retried while the store still says the container is running: a project's
  // sessions all open at once and that burst is exactly what makes `docker
  // inspect` answer non-zero, which isRunning() reads as "container stopped".
  React.useEffect(() => {
    if (!running || !chat) return
    if (chat.open || chat.opening) return
    if (chat.reason !== 'container-stopped' && chat.reason !== 'spawn-failed') return
    const t = setTimeout(() => void openChat(project.id, session.id, true), 900)
    return () => clearTimeout(t)
  }, [running, chat, openChat, project.id, session.id])

  React.useEffect(() => {
    void window.vivarium.chatMountTree(project.id).then(setTree)
  }, [project.id])

  // Follow the tail unless the user has scrolled up to read something.
  React.useEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [chat?.entries.length, visible])

  const entries = chat?.entries ?? []
  const blocking = chat?.blocking ?? null
  const todos = chat?.todos ?? []
  const mode: ChatMode = chat?.mode ?? session.mode ?? 'bypassPermissions'

  const handlers: LogHandlers = {
    onExpand: (id) => void loadBody(session.id, id),
    onExpandTask: (toolUseId, agentId) => void loadSubagent(session.id, toolUseId, agentId),
    bodies: chat?.bodies ?? {},
    subagents: chat?.subagents ?? {},
    onRetry: () => void openChat(project.id, session.id, true)
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const next: PendingChip[] = []
    for (const f of Array.from(files)) {
      // Electron 31 still puts the real path on the File; past 32 this becomes
      // webUtils.getPathForFile in the preload.
      const hostPath = (f as File & { path?: string }).path
      next.push(await routeFile(f, hostPath, tree))
    }
    setChips((c) => [...c, ...next])
  }

  const send = (): void => {
    const text = draft.trim()
    // A refusal cannot be sent — it is the same chip in a failed state, carrying
    // its reason, attached to the thing that caused it rather than to a toast
    // that disappears while you are reading it.
    const ready = chips.flatMap((c) => (c.ok ? [c.attachment] : []))
    if (!text && ready.length === 0) return
    void sendChat(session.id, text, ready)
    setDraft('')
    setChips([])
    setMenu(null)
    pinned.current = true
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // The Esc handler lives on the chat container, not on the composer input, so it
  // fires with focus on a tool card's expand button too — and never while a
  // dialog is open, since a dialog takes focus out of this subtree. Esc keeps the
  // single meaning it has everywhere else: stop this turn. With nothing running
  // it is a no-op, and it must never clear the draft — a stray Esc destroying a
  // half-written prompt is the only genuinely unrecoverable outcome in this area.
  const onContainerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    void interruptChat(session.id)
  }

  const onDraft = (v: string, caret: number): void => {
    setDraft(v)
    // `/` opens only when it is the composer's first character — the sole
    // position the CLI expands one — so the menu can never offer a completion
    // that would be sent as prose.
    if (v.startsWith('/') && caret <= v.length && !v.slice(0, caret).includes(' ')) {
      setMenu({ kind: 'slash', query: v.slice(1, caret) })
      return
    }
    const before = v.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at >= 0 && !/\s/.test(before.slice(at + 1))) {
      setMenu({ kind: 'at', query: before.slice(at + 1) })
      return
    }
    setMenu(null)
  }

  const pickCommand = (name: string): void => {
    setDraft(`${name} `)
    setMenu(null)
    inputRef.current?.focus()
  }

  const pickNode = (node: MountNode): void => {
    setChips((c) => [...c, chipForNode(node)])
    // The `@` token itself is dropped — you picked from the tree and never have
    // to see either kind of path.
    const caret = inputRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, caret)
    const at = before.lastIndexOf('@')
    setDraft(at >= 0 ? before.slice(0, at) + draft.slice(caret) : draft)
    setMenu(null)
    inputRef.current?.focus()
  }

  const openModelMenu = async (): Promise<void> => {
    setModelMenu((v) => !v)
    if (models) return
    setModels(await window.vivarium.chatModels(session.id))
  }

  return (
    <div
      onKeyDown={onContainerKeyDown}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
      }}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--terminal-bg)',
        // Hidden rather than unmounted, like a terminal — but for a weaker
        // reason: nothing in a chat is unrecoverable, so terminals *must* stay
        // mounted while a chat merely *may*. What it buys is scroll position,
        // which cards are expanded, and the draft.
        visibility: visible ? 'visible' : 'hidden',
        outline: dragOver ? `1px dashed ${ACCENT.chat}` : 'none'
      }}
    >
      <Header
        session={session}
        project={project}
        mode={mode}
        model={chat?.model ?? null}
        contextPct={chat?.context?.percentage ?? null}
        contextTitle={
          chat?.context
            ? `${tok(chat.context.totalTokens)} / ${tok(chat.context.maxTokens)} · ${chat.context.percentage}%${chat.context.approximate ? ' (approximate)' : ''}`
            : 'Context usage unavailable'
        }
        onMode={(m) => void setChatMode(session.id, m)}
        onModelClick={() => void openModelMenu()}
        modelMenu={modelMenu}
        models={models}
        onPickModel={(m) => {
          setModelMenu(false)
          void setChatModel(session.id, m)
        }}
      />

      {/* Not a gutter row: the gutter is a timeline and a failed read is not an
          event in time. The chat stays usable — the process spawns fine, only the
          history is missing — so this is a banner, and it clears on a successful
          read rather than on a dismiss. */}
      {chat?.historyError && (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 16px',
            background: 'var(--panel)',
            borderBottom: '1px solid var(--border)',
            fontSize: 12.5,
            color: 'var(--text-2)'
          }}
        >
          <span>Could not read this conversation’s history — {chat.historyError}</span>
          <button
            onClick={() => void openChat(project.id, session.id, true)}
            style={{
              fontFamily: MONO,
              fontSize: 12,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-2)',
              padding: '2px 10px',
              cursor: 'pointer'
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '12px 0 16px' }}
      >
        {chat && chat.total > entries.length && (
          <button
            onClick={() => void loadEarlier(session.id)}
            style={{
              display: 'block',
              margin: '4px auto 12px',
              fontFamily: MONO,
              fontSize: 11.5,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-3)',
              padding: '3px 12px',
              cursor: 'pointer'
            }}
          >
            load earlier ({chat.total - entries.length})
          </button>
        )}
        {entries.map((e) => (
          <LogRow key={e.id} entry={e} handlers={handlers} />
        ))}
        {entries.length === 0 && chat?.open && (
          <div
            style={{
              padding: '48px 16px',
              textAlign: 'center',
              fontSize: 13,
              color: 'var(--text-3)'
            }}
          >
            Nothing said yet — ask something below.
          </div>
        )}
      </div>

      {/* The pinned region: three bands, widest scope to narrowest, each absent
          entirely when empty. Nothing is ever hidden by something else — letting
          a pending card displace the todo strip was rejected, because it does not
          make the buttons more visible (they are adjacent either way) and it
          costs a disappearance the user did not cause. */}
      {todos.length > 0 && <TodoStrip todos={todos} />}
      {blocking && (
        <BlockingBar
          card={blocking}
          onAnswer={(answer) => void answerChat(session.id, blocking.requestId, answer)}
        />
      )}
      {chips.length > 0 && (
        <ChipStrip chips={chips} onRemove={(id) => setChips((c) => c.filter((x) => x.id !== id))} />
      )}

      <div style={{ flex: 'none', borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
        {menu && (
          <Typeahead
            kind={menu.kind}
            query={menu.query}
            commands={chat?.commands ?? []}
            tree={tree}
            onCommand={pickCommand}
            onNode={pickNode}
          />
        )}
        <div style={{ padding: '12px 16px 14px' }}>
          <textarea
            ref={inputRef}
            rows={2}
            value={draft}
            onChange={(e) => onDraft(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData.files)
              if (items.length) {
                e.preventDefault()
                void addFiles(items)
              }
            }}
            placeholder={placeholderFor(chat?.open ?? false, !!blocking, isWorking(entries))}
            style={{
              display: 'block',
              width: '100%',
              border: '1px solid var(--border)',
              // The one piece of feedback left: the box says it has the keyboard.
              borderColor: focus ? 'var(--text-3)' : 'var(--border)',
              background: 'var(--field)',
              color: 'var(--text)',
              fontSize: 14,
              lineHeight: 1.6,
              padding: '11px 13px',
              resize: 'none',
              outline: 'none',
              // The find-bar precedent: a control focused for as long as it exists
              // has no business lighting the global focus ring.
              boxShadow: 'none'
            }}
          />
        </div>
      </div>
    </div>
  )
}

function tok(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** A turn is in flight while its clock row has no frozen duration yet. */
function isWorking(entries: ChatEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'turn') return e.durationMs === undefined
  }
  return false
}

/** The placeholder is the only thing that follows the stage. */
function placeholderFor(open: boolean, blocking: boolean, working: boolean): string {
  if (!open) return 'Connecting…'
  if (blocking) return 'Answer above, or type to redirect…'
  if (working) return 'Type to queue a follow-up…'
  return 'Ask, or paste an image with Ctrl+V…'
}

// ---- chrome ---------------------------------------------------------------
/**
 * Exactly three items on the right, and it gains no fourth: the mode chip and the
 * model chip are things you *press*, and the context meter is the only pure
 * reading left — which is what makes the other two read as controls at all. The
 * turn clock went into the log for this reason, and cost stayed out entirely.
 */
function Header({
  session,
  project,
  mode,
  model,
  contextPct,
  contextTitle,
  onMode,
  onModelClick,
  modelMenu,
  models,
  onPickModel
}: {
  session: Session
  project: Project
  mode: ChatMode
  model: string | null
  contextPct: number | null
  contextTitle: string
  onMode: (m: ChatMode) => void
  onModelClick: () => void
  modelMenu: boolean
  models: string[] | null
  onPickModel: (m: string) => void
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        height: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 16px',
        borderBottom: '1px solid var(--border)',
        position: 'relative'
      }}
    >
      <span style={{ display: 'flex', color: ACCENT.chat }}>
        <ChatBubble size={15} />
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 500 }}>{session.name}</span>
      <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{project.name}</span>
      <div style={{ flex: 1 }} />

      {/* Two modes, live — set_permission_mode is accepted mid-conversation and
          even mid-turn. Plain "plan" / "bypass": no warning chrome and no
          explanatory tooltip. Plan mode being advisory here is a known accepted
          property of this tool (terminal agents already run
          --dangerously-skip-permissions), not something the UI argues with the
          user about every time they look at it. */}
      <div style={{ display: 'flex', border: '1px solid var(--border)', height: 26 }}>
        {(['plan', 'bypassPermissions'] as const).map((m) => {
          const active = mode === m
          const hue = m === 'plan' ? CHIP.plan : CHIP.bypass
          return (
            <button
              key={m}
              onClick={() => onMode(m)}
              style={{
                border: 0,
                background: active ? `${hue}22` : 'transparent',
                color: active ? hue : 'var(--text-3)',
                fontSize: 12,
                fontFamily: MONO,
                fontWeight: active ? 500 : 400,
                height: 24,
                padding: '0 11px',
                cursor: 'pointer'
              }}
            >
              {m === 'plan' ? 'plan' : 'bypass'}
            </button>
          )
        })}
      </div>

      <span style={{ width: 1, height: 16, background: 'var(--border)' }} />

      <button
        onClick={onModelClick}
        style={{
          fontSize: 12,
          fontFamily: MONO,
          color: CHIP.model,
          background: 'transparent',
          border: '1px solid var(--border)',
          height: 24,
          display: 'flex',
          alignItems: 'center',
          padding: '0 9px',
          cursor: 'pointer'
        }}
      >
        {shortModel(model)}
      </button>

      {modelMenu && (
        <div
          style={{
            position: 'absolute',
            top: 38,
            right: 100,
            zIndex: 20,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            boxShadow: '0 18px 44px -16px rgba(0,0,0,.7)',
            minWidth: 200,
            maxHeight: 280,
            overflowY: 'auto'
          }}
        >
          {models === null && (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-3)' }}>loading…</div>
          )}
          {models?.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-3)' }}>
              no models reported
            </div>
          )}
          {models?.map((m) => (
            <button
              key={m}
              onClick={() => onPickModel(m)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                border: 0,
                background: 'transparent',
                color: m === model ? 'var(--text)' : 'var(--text-2)',
                fontFamily: MONO,
                fontSize: 12,
                padding: '7px 12px',
                cursor: 'pointer'
              }}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      {/* The bare bar. No inline percentage (that idiom belongs to the title-bar
          chips and costs ~30px here) and not clickable — a click sending
          /context was genuinely cheap, but it would make a header click *write to
          the transcript*, which nothing else in the header does. Red at 85% is
          the entire warning: a compaction is the tool working, not a failure. */}
      <span title={contextTitle} style={{ display: 'flex', alignItems: 'center', height: 24 }}>
        <span
          style={{
            width: 72,
            height: 8,
            background: 'var(--field-2)',
            border: '1px solid var(--border-2)',
            display: 'block'
          }}
        >
          {contextPct !== null && (
            <span
              style={{
                display: 'block',
                width: `${Math.min(100, contextPct)}%`,
                height: '100%',
                background: ctxColor(contextPct)
              }}
            />
          )}
        </span>
      </span>
    </div>
  )
}

/** `claude-opus-5-…` → `opus-5`, and "default" when the CLI has not said yet. */
function shortModel(id: string | null): string {
  if (!id) return 'default'
  const m = /^claude-([a-z]+(?:-[0-9.]+)?)/.exec(id)
  return m ? m[1] : id
}

// ---- the three pinned bands ------------------------------------------------
/**
 * Present whenever the list is non-empty, gone only when every task has been
 * deleted — an all-completed list keeps showing its ticks, because those tasks
 * really are still on the agent's list and it may reopen one. The strip cannot
 * disagree with what the agent believes.
 */
function TodoStrip({ todos }: { todos: ChatTodo[] }): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        padding: '7px 16px',
        borderTop: '1px solid var(--border-2)',
        fontFamily: MONO,
        fontSize: 11.5,
        color: 'var(--text-3)'
      }}
    >
      {todos.map((t) => (
        <span key={t.id} style={{ color: t.status === 'in_progress' ? 'var(--text)' : undefined }}>
          {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}{' '}
          {t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject}
        </span>
      ))}
    </div>
  )
}

/**
 * Blocking keeps two surfaces, not one: the plan body renders in the log, in its
 * place in time, so the transcript stays a complete record — and the buttons are
 * pinned here, so a decision cannot scroll away behind twenty tool calls.
 */
function BlockingBar({
  card,
  onAnswer
}: {
  card: ChatBlockingCard
  onAnswer: (a: ChatAnswer) => void
}): React.ReactElement {
  const [notes, setNotes] = React.useState('')
  const [picks, setPicks] = React.useState<Record<string, string[]>>({})

  const toggle = (q: string, label: string, multi: boolean): void =>
    setPicks((p) => {
      const cur = p[q] ?? []
      if (!multi) return { ...p, [q]: [label] }
      return { ...p, [q]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
    })

  if (card.kind === 'question') {
    const questions = card.questions ?? []
    const ready = questions.every((q) => (picks[q.question] ?? []).length > 0)
    return (
      <Bar hue={CHIP.plan}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {questions.map((q) => (
            <div key={q.question} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 5 }}>{q.question}</div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {q.options.map((o) => {
                  const on = (picks[q.question] ?? []).includes(o.label)
                  return (
                    <button
                      key={o.label}
                      title={o.description}
                      onClick={() => toggle(q.question, o.label, q.multiSelect)}
                      style={{
                        fontFamily: MONO,
                        fontSize: 12,
                        padding: '4px 10px',
                        border: `1px solid ${on ? ACCENT.chat : 'var(--border)'}`,
                        background: on ? 'rgba(192,139,184,.12)' : 'transparent',
                        color: on ? 'var(--text)' : 'var(--text-2)',
                        cursor: 'pointer'
                      }}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <button
          disabled={!ready}
          onClick={() =>
            // The answers map is keyed by question *text*: an `allow` without one
            // yields "The user did not answer the questions." with no error
            // raised anywhere, which would silently break the card.
            onAnswer({
              behavior: 'question',
              answers: Object.fromEntries(
                questions.map((q) => {
                  const picked = picks[q.question] ?? []
                  return [q.question, q.multiSelect ? picked : picked[0]]
                })
              )
            })
          }
          style={primaryButton(!ready)}
        >
          Answer
        </button>
      </Bar>
    )
  }

  if (card.kind === 'plan') {
    return (
      <Bar hue={CHIP.plan}>
        <span style={{ fontSize: 13.5, color: 'var(--text)' }}>Plan awaiting approval</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="revision notes (optional)"
          style={{
            flex: 1,
            minWidth: 80,
            height: 30,
            background: 'var(--field)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            fontSize: 12.5,
            padding: '0 10px',
            outline: 'none'
          }}
        />
        {/* Approving does not by itself leave plan mode; the host chooses the
            next mode, and with two modes there is nothing else approval could
            mean — so the toggle visibly moves to bypass. */}
        <button onClick={() => onAnswer({ behavior: 'plan-approve' })} style={primaryButton(false)}>
          Approve &amp; run
        </button>
        <button
          onClick={() =>
            onAnswer({ behavior: 'plan-deny', message: notes.trim() || 'Keep planning.' })
          }
          style={secondaryButton}
        >
          Keep planning
        </button>
      </Bar>
    )
  }

  return (
    <Bar hue={CHIP.plan}>
      <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{card.title}</span>
      <div style={{ flex: 1 }} />
      <button onClick={() => onAnswer({ behavior: 'allow' })} style={primaryButton(false)}>
        Allow
      </button>
      <button onClick={() => onAnswer({ behavior: 'deny' })} style={secondaryButton}>
        Deny
      </button>
    </Bar>
  )
}

function Bar({ hue, children }: { hue: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '9px 16px',
        background: 'var(--panel)',
        borderTop: `2px solid ${hue}`
      }}
    >
      {children}
    </div>
  )
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    flex: 'none',
    height: 32,
    padding: '0 17px',
    border: 0,
    background: disabled ? 'var(--field-2)' : 'var(--accent)',
    color: disabled ? 'var(--text-3)' : '#fff',
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer'
  }
}

const secondaryButton: React.CSSProperties = {
  flex: 'none',
  height: 32,
  padding: '0 17px',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontSize: 13,
  cursor: 'pointer'
}

/**
 * Pending chips and refusals share one surface. A refusal is the same chip in a
 * failed state, carrying its reason, and cannot be sent — the error attaches to
 * the thing that caused it, rather than to a toast that disappears while you are
 * reading it or a log row that never went to the model.
 */
function ChipStrip({
  chips,
  onRemove
}: {
  chips: PendingChip[]
  onRemove: (id: string) => void
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 16px',
        borderTop: '1px solid var(--border-2)'
      }}
    >
      {chips.map((c) => (
        <div
          key={c.id}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 9,
            fontFamily: MONO,
            fontSize: 12,
            color: c.ok ? 'var(--text-2)' : 'var(--danger)'
          }}
        >
          <span style={{ flex: 'none' }}>{c.ok ? (c.attachment.kind === 'image' ? '▣' : '≡') : '⚠'}</span>
          <span style={{ color: 'var(--text)' }}>{c.ok ? c.attachment.name : c.name}</span>
          <span style={{ flex: 1, minWidth: 0, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.ok ? c.detail : c.reason}
          </span>
          <button
            onClick={() => onRemove(c.id)}
            style={{
              flex: 'none',
              border: 0,
              background: 'transparent',
              color: 'var(--text-3)',
              cursor: 'pointer',
              padding: '0 4px'
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * The composer's two typeaheads.
 *
 * The `/` list is `slash_commands[]` + `skills[]`, unfiltered, showing **name and
 * source only** — `init` carries names and nothing else, so there are no
 * descriptions, no argument-hints, no per-command forms. Picking inserts `/name `
 * and dismisses; everything after is free text, including the second `/foo` in
 * `/loop 5m /foo`. The composer never parses a command: every `/…` is forwarded
 * verbatim and whatever happens next is Claude Code's business, which is what
 * keeps this from rotting as the CLI ships new commands.
 */
function Typeahead({
  kind,
  query,
  commands,
  tree,
  onCommand,
  onNode
}: {
  kind: 'slash' | 'at'
  query: string
  commands: string[]
  tree: MountNode[]
  onCommand: (name: string) => void
  onNode: (n: MountNode) => void
}): React.ReactElement | null {
  const q = query.toLowerCase()
  const rows =
    kind === 'slash'
      ? commands.filter((c) => c.toLowerCase().includes(q)).slice(0, 12)
      : flattenTree(tree)
          .filter((n) => n.type === 'file' && n.name.toLowerCase().includes(q))
          .slice(0, 12)
  if (rows.length === 0) return null
  return (
    <div
      style={{
        maxHeight: 240,
        overflowY: 'auto',
        borderBottom: '1px solid var(--border-2)',
        background: 'var(--panel)'
      }}
    >
      {rows.map((r) => {
        const node = typeof r === 'string' ? null : r
        return (
          <button
            key={node ? node.containerPath : (r as string)}
            onMouseDown={(e) => {
              // mousedown, not click: a blur would close this before the click.
              e.preventDefault()
              if (node) onNode(node)
              else onCommand(`/${String(r).replace(/^\//, '')}`)
            }}
            style={{
              display: 'flex',
              gap: 10,
              width: '100%',
              textAlign: 'left',
              border: 0,
              background: 'transparent',
              color: 'var(--text-2)',
              fontFamily: MONO,
              fontSize: 12,
              padding: '5px 16px',
              cursor: 'pointer'
            }}
          >
            <span style={{ color: 'var(--text)' }}>{node ? node.name : String(r)}</span>
            {node && (
              <span style={{ color: 'var(--text-3)', opacity: 0.8 }}>{node.containerPath}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
