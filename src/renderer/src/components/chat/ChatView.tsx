import React from 'react'
import type {
  ChatAnswer,
  ChatBlockingCard,
  ChatContextUsage,
  ChatEntry,
  ChatMode,
  ChatModelOption,
  ChatQuestion,
  ChatTodo,
  MountNode,
  Project,
  Session
} from '@shared/types'
import { modelName, modelOptionLabel } from '@shared/models'
import { useStore } from '../../state/store'
import { CHAT, CHAT_MEASURE as MEASURE, MONO, ctxColor } from '../../theme'
import { Copy, Refresh, ZoomIn, ZoomOut } from '../Icons'
import { LogRow, type LogHandlers } from './ChatLog'
import { Preview } from './Markdown'
import { chipForNode, flattenTree, routeFile, type PendingChip } from './attach'

// The chat window, built to `docs/redisign/Chat Terminal.html`: a 52px header of
// readings, a log centred in an 880px reading column, and a composer that is a
// raised panel with a status line inside it.
//
// **The composer is no longer "only a box".** The earlier version had no send
// button and no `⏎ send` hint on the argument that every affordance already had a
// free home — Enter sends, Esc interrupts, Ctrl+V attaches. That argument is
// sound about *capability* and wrong about *discoverability*: none of it is on
// screen, so none of it is findable, and the mode and model you are about to send
// under were only readable by looking back up at the header. The footer row
// carries all of it — `plan · haiku-4` on the left, `⏎ send · ⇧⏎ newline` and a
// send button on the right — inside the box, which costs one line and no chrome
// anywhere else. Attaching stays gesture-only (Ctrl+V, drag-drop, `@`), and Esc
// is still taught on the live working row where it is the only thing that helps.

/**
 * The reading column's `max-width`, in the zoomed coordinate system the column
 * is laid out in.
 *
 * `zoom` scales an element's own box, so a plain `maxWidth: MEASURE` is MEASURE
 * *zoomed* pixels — at 0.7 the column drew 616 real pixels wide and pulled both
 * of its edges in from the window, so zooming out made the text smaller **and**
 * the page narrower and left a band of dead background down each side. Dividing
 * it back out pins the column to MEASURE real pixels instead: the page holds
 * still and only the type in it changes size, which is what a zoom is for.
 *
 * Only below 1×, hence the `min`. Zooming *in* is the case where growing with
 * the type is right — the column keeps roughly the same measure in characters
 * and simply fills more of the window, up to the window — and that direction was
 * never what looked broken.
 */
function columnMax(zoom: number): number {
  return MEASURE / Math.min(zoom, 1)
}

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
  /**
   * Which typeahead row is highlighted, or `null` for "none yet".
   *
   * The null is not laziness, it is what makes Enter safe: with nothing
   * highlighted, Enter sends `/clear` as the command you typed, and only once
   * you have deliberately reached into the list does it mean "take this one".
   * It is also the first half of the two-press Tab.
   */
  const [pick, setPick] = React.useState<number | null>(null)
  const [models, setModels] = React.useState<ChatModelOption[] | null>(null)
  const [modelMenu, setModelMenu] = React.useState(false)

  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const logRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)
  const zoom = useStore((s) => s.chatZoom)

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
  //
  // A ResizeObserver on the content, not an effect on `entries.length`: a turn
  // streaming its answer *grows the last row* rather than adding one, so the
  // length never changed, the effect never ran, and the sentence being written
  // slid off the bottom of a log that was supposed to be following it. Height
  // is what actually moves, so height is what to watch — and watching it covers
  // the other three cases for free (a tool card expanded, a settle replacing a
  // turn with taller rows, the composer growing under the log).
  React.useEffect(() => {
    const el = logRef.current
    const content = contentRef.current
    if (!el || !content) return
    const stick = (): void => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(stick)
    ro.observe(content)
    // The scroller too, not only its content: a composer growing to three lines
    // takes height *away* from the log without changing anything inside it, and
    // the tail would slide out from under the box you are typing in.
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Becoming visible is not a resize (the view is hidden with `visibility`, so
  // it keeps its layout the whole time), and a chat that was at the bottom when
  // you left it should be at the bottom when you come back.
  React.useEffect(() => {
    const el = logRef.current
    if (visible && el && pinned.current) el.scrollTop = el.scrollHeight
  }, [visible])

  // Ctrl + wheel zooms, the terminal's convention. A native listener because it
  // has to be non-passive: React registers wheel at the root as passive, where
  // preventDefault is ignored and the page zooms *and* scrolls.
  React.useEffect(() => {
    const el = logRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      useStore.getState().zoomChat(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // The composer grows with the draft to a ceiling, then scrolls. A textarea
  // cannot do this itself — `rows` is a fixed count and `height:auto` measures to
  // one line — so the height is set from scrollHeight, and reset to `auto` first
  // or it can only ever grow. Layout effect, not effect: measuring after paint
  // shows one frame of the wrong height on every keystroke.
  React.useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(180, Math.max(26, el.scrollHeight))}px`
  }, [draft, visible])

  const entries = chat?.entries ?? []
  const blocking = chat?.blocking ?? null
  const todos = chat?.todos ?? []
  const mode: ChatMode = chat?.mode ?? session.mode ?? 'bypassPermissions'
  const working = isWorking(entries)
  const canSend = draft.trim().length > 0 || chips.some((c) => c.ok)

  // The row the turn is writing into right now — the only one revealed at a
  // steady rate rather than painted the instant its bytes arrive (see
  // REVEAL_CATCHUP in ChatLog). Everything else, including the paragraphs above
  // it in the same turn, is finished text and paints whole.
  //
  // **Scoped to the running turn, and that is the whole point.** A turn is
  // `working` from the moment the message is sent, which is seconds before the
  // model writes its first word — so "the last claude row in the log" is the
  // *previous* answer for that whole window. Flagging it re-opened it to the
  // reveal, which restarted from wherever the reveal had been frozen at the end
  // of its own turn: the finished paragraph vanished and typed itself out again
  // every time you sent a follow-up. Matching on the turn means a turn that has
  // not produced a word yet has no streaming row at all, which is the truth.
  const streamingId = React.useMemo(() => {
    if (!working) return null
    // The clock row is appended at send, so it exists before any prose does and
    // carries the running turn's number. Found by scanning rather than by taking
    // the last one: a settle for the *previous* turn re-appends that turn's rows
    // (clock included) at the end of the list, and it can land after this one.
    let turn: number | null = null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'turn' && e.durationMs === undefined) {
        turn = e.turn
        break
      }
    }
    if (turn === null) return null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'text' && e.role === 'claude' && e.turn === turn) return e.id
    }
    return null
  }, [working, entries])

  // Memoised because `LogRow` is memoised: a new handlers object every render
  // would defeat it, and defeating it is what made a streaming turn re-render
  // every row in the log for every token that arrived.
  const handlers: LogHandlers = React.useMemo(
    () => ({
      onExpand: (id: string) => void loadBody(session.id, id),
      onExpandTask: (toolUseId: string, agentId: string | null) =>
        void loadSubagent(session.id, toolUseId, agentId),
      bodies: chat?.bodies ?? {},
      subagents: chat?.subagents ?? {},
      onRetry: () => void openChat(project.id, session.id, true)
    }),
    [chat?.bodies, chat?.subagents, loadBody, loadSubagent, openChat, project.id, session.id]
  )

  /**
   * The typeahead's rows, computed here rather than inside the component that
   * draws them: the keyboard has to move a selection through the same list the
   * mouse clicks, and two copies of the filter would disagree the moment either
   * one grew a rule.
   */
  const menuRows = React.useMemo(
    () => (menu ? typeaheadRows(menu, chat?.commands ?? [], tree) : []),
    [menu, chat?.commands, tree]
  )

  // A new query is a new list, so the highlight starts over. Without this, a
  // narrowing filter leaves you pointing at whatever now sits at that index.
  React.useEffect(() => {
    setPick(null)
  }, [menu?.kind, menu?.query])

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
    const sentDraft = draft
    const sentChips = chips
    setDraft('')
    setChips([])
    setMenu(null)
    pinned.current = true
    void sendChat(session.id, text, ready).then((ok) => {
      // The process was gone — nothing was written and no row will ever appear
      // for it. Clearing the box optimistically is right (the send all but always
      // works, and a box that empties on Enter is the whole feel of a composer),
      // but *keeping* it cleared here would silently eat the message.
      if (ok) return
      setDraft((d) => (d ? d : sentDraft))
      setChips((c) => (c.length ? c : sentChips))
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu && menuRows.length > 0) {
      const move = (d: number): void => {
        e.preventDefault()
        setPick((p) =>
          p === null ? (d > 0 ? 0 : menuRows.length - 1) : (p + d + menuRows.length) % menuRows.length
        )
      }
      if (e.key === 'ArrowDown') return move(1)
      if (e.key === 'ArrowUp') return move(-1)
      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) return move(-1)
        // Two presses, shell-style: the first highlights the best match, the
        // second takes it. One press could not do both — completing straight
        // away means you can never *look* at the list, and only highlighting
        // means Tab alone never completes anything.
        if (pick === null) return setPick(0)
        return acceptRow(menuRows[pick])
      }
      // Enter takes the highlighted row only when you put the highlight there.
      // With none, `/clear` + Enter is still the command you typed being sent.
      if (e.key === 'Enter' && !e.shiftKey && pick !== null) {
        e.preventDefault()
        return acceptRow(menuRows[pick])
      }
      if (e.key === 'Escape') {
        // preventDefault, so the window-level Esc does not read a dismissed
        // menu as "interrupt the turn".
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const acceptRow = (row: TypeaheadRow): void => {
    if (row.node) pickNode(row.node)
    else pickCommand(row.name)
  }

  // Esc keeps the single meaning it has everywhere else in the app: stop this
  // turn. With nothing running it is a no-op, and it must never clear the draft —
  // a stray Esc destroying a half-written prompt is the only genuinely
  // unrecoverable outcome in this area.
  //
  // It listens on the **window**, not on the chat container, and that is the fix
  // rather than a preference: React delivers keydown by bubbling from the focused
  // element, and this view spends most of its life with focus on `document.body`
  // — every click on the log, on a tool card's body, on the scrollbar, and the
  // whole time after a send lands and blurs nothing. Those events never enter the
  // container's subtree at all, so the handler that lived there fired only while
  // the caret was in the composer, which reads as "esc does nothing".
  //
  // Guarded twice over: only the visible view (one chat is mounted per opened
  // session, all but one hidden), and never while a dialog or a context menu is
  // up, where Esc means dismiss and the owner of that surface handles it.
  //
  // The zoom chords ride along on the same listener, for the same reason: the
  // composer is the only focused element most of the time, and a chord bound to
  // the container would be dead everywhere else in the window.
  React.useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const s = useStore.getState()
      if (s.dialog || s.contextMenu) return
      // Ctrl +/-/0 — the chords TerminalView already binds. The two panes of
      // this app must not disagree about how you make the text bigger.
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          return s.zoomChat(1)
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          return s.zoomChat(-1)
        }
        if (e.key === '0') {
          e.preventDefault()
          return s.resetChatZoom()
        }
      }
      if (e.key !== 'Escape') return
      void interruptChat(session.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, interruptChat, session.id])

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
    setPick(null)
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
    setPick(null)
    inputRef.current?.focus()
  }

  /**
   * The leading `/command` when it is one the CLI actually has — what the
   * composer tints. Checked against `chat.commands` rather than against a
   * pattern, so a typo stays plain text and the highlight means "this will
   * expand", not "this begins with a slash".
   */
  const commandToken = React.useMemo(() => {
    if (!draft.startsWith('/')) return null
    const token = /^\/\S*/.exec(draft)?.[0] ?? ''
    const name = token.slice(1).toLowerCase()
    if (!name) return null
    const known = (chat?.commands ?? []).some(
      (c) => c.replace(/^\//, '').toLowerCase() === name
    )
    return known ? token : null
  }, [draft, chat?.commands])

  const openModelMenu = async (): Promise<void> => {
    setModelMenu((v) => !v)
    if (models) return
    setModels(await window.vivarium.chatModels(session.id))
  }

  return (
    <div
      // The scope for every chat rule in GLOBAL_CSS — the control radius and the
      // scrollbar. It is a class rather than a wrapper selector so the rules die
      // with this subtree and can never reach the slate chrome around it.
      className="vchat"
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
        background: CHAT.bg,
        color: CHAT.text,
        // **The whole window is mono, and it is set once, here.** `body` is IBM
        // Plex Sans and everything inherits from it, so one declaration on the
        // root turns the log, the markdown, the composer and every control mono
        // at once — including the textarea, which `input,button,textarea{font-
        // family:inherit}` in GLOBAL_CSS already wires to its parent. The
        // explicit `fontFamily: MONO` further down are now saying again what
        // this says; they are left alone rather than swept, because each of them
        // is also what stops a *future* wrapper from quietly restyling a chip.
        fontFamily: MONO,
        // Hidden rather than unmounted, like a terminal — but for a weaker
        // reason: nothing in a chat is unrecoverable, so terminals *must* stay
        // mounted while a chat merely *may*. What it buys is scroll position,
        // which cards are expanded, and the draft.
        visibility: visible ? 'visible' : 'hidden',
        outline: dragOver ? `1px dashed ${CHAT.you}` : 'none'
      }}
    >
      <Header
        session={session}
        project={project}
        mode={mode}
        model={chat?.model ?? null}
        context={chat?.context ?? null}
        live={!!chat?.open}
        onMode={(m) => void setChatMode(session.id, m)}
        onModelClick={() => void openModelMenu()}
        onCloseModelMenu={() => setModelMenu(false)}
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
            padding: '8px 20px',
            background: CHAT.card,
            borderBottom: `1px solid ${CHAT.borderSoft}`,
            fontSize: 12.5,
            color: CHAT.dim
          }}
        >
          <span>Could not read this conversation’s history — {chat.historyError}</span>
          <button
            onClick={() => void openChat(project.id, session.id, true)}
            style={{
              fontFamily: MONO,
              fontSize: 11.5,
              border: `1px solid ${CHAT.border}`,
              background: 'transparent',
              color: CHAT.dim2,
              padding: '2px 10px',
              cursor: 'pointer'
            }}
          >
            retry
          </button>
        </div>
      )}

      <div
        ref={logRef}
        className="vchat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        // The one place the zoom chords are written down. Same argument as the
        // terminal's menu, which is where Ctrl+F and Ctrl+± are taught: a chord
        // nothing on screen mentions may as well not exist.
        onContextMenu={(e) => {
          e.preventDefault()
          const z = useStore.getState()
          const selection = window.getSelection()?.toString() ?? ''
          z.openContextMenu(e.clientX, e.clientY, [
            {
              label: 'Copy',
              icon: <Copy size={14} />,
              hint: 'Ctrl+C',
              disabled: !selection,
              onSelect: () => void window.vivarium.clipboardWriteText(selection)
            },
            { label: '---' },
            { label: 'Zoom in', icon: <ZoomIn size={14} />, hint: 'Ctrl++', onSelect: () => z.zoomChat(1) },
            { label: 'Zoom out', icon: <ZoomOut size={14} />, hint: 'Ctrl+-', onSelect: () => z.zoomChat(-1) },
            {
              label: 'Reset zoom',
              icon: <Refresh size={14} />,
              hint: 'Ctrl+0',
              onSelect: () => z.resetChatZoom()
            }
          ])
        }}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {/* The reading column. Everything below the header lives in it — the log,
            the pinned bands and the composer — so a message, the plan you are
            approving and the box you answer in all share one left and right edge.

            `zoom` rather than a font size threaded through thirty components:
            the chat is a whole layout (a 96px gutter, an 880px measure, cards, a
            composer) and scaling only the type would leave every one of those
            behind at its 1× proportions. It sits on the *column* and not on the
            view root because a zoomed `position:absolute; inset:0` box scales
            its own edges, and the column is a plain auto-width block — it fills
            the scroller at any factor, exactly the way browser zoom behaves. The
            composer's column carries the same factor *and the same max*, so the
            two stay aligned at every step (see columnMax). */}
        <div
          ref={contentRef}
          style={{
            zoom,
            maxWidth: columnMax(zoom),
            margin: '0 auto',
            padding: '26px 24px 40px'
          }}
        >
          {chat && chat.total > entries.length && (
            <button
              onClick={() => void loadEarlier(session.id)}
              style={{
                display: 'block',
                margin: '0 auto 18px',
                fontFamily: MONO,
                fontSize: 10.5,
                border: `1px solid ${CHAT.border}`,
                background: 'transparent',
                color: CHAT.dim3,
                padding: '4px 12px',
                cursor: 'pointer'
              }}
            >
              load earlier ({chat.total - entries.length})
            </button>
          )}
          {entries.map((e) => (
            <LogRow key={e.id} entry={e} handlers={handlers} streaming={e.id === streamingId} />
          ))}
          {entries.length === 0 && chat?.open && (
            <div
              style={{
                padding: '48px 18px',
                fontSize: 13.5,
                lineHeight: 1.7,
                color: CHAT.dim3
              }}
            >
              Nothing said yet — ask something below.
            </div>
          )}
        </div>
      </div>

      {/* The composer region floats over the end of the log rather than sitting
          below it: the gradient is what makes the last row fade out under the box
          instead of stopping at a hard rule. */}
      <div
        style={{
          flex: 'none',
          padding: '0 24px 22px',
          background: `linear-gradient(to top, ${CHAT.bg} 70%, ${CHAT.bg}00)`
        }}
      >
        <div style={{ zoom, maxWidth: columnMax(zoom), margin: '0 auto', position: 'relative' }}>
          {/* The pinned bands, widest scope to narrowest, each absent entirely
              when empty. Nothing is ever hidden by something else — letting a
              pending card displace the todo strip was rejected, because it does
              not make the buttons more visible (they are adjacent either way) and
              it costs a disappearance the user did not cause. */}
          {todos.length > 0 && <TodoStrip todos={todos} />}
          {blocking && (
            // Keyed on the request, so a card *replaced* rather than answered
            // starts empty. Answering unmounts the bar and takes its state with
            // it, but two `can_use_tool` requests arriving back to back never
            // pass through null — and half-ticked options carried into the next
            // question are an answer nobody gave.
            <BlockingBar
              key={blocking.requestId}
              card={blocking}
              onAnswer={(answer) => void answerChat(session.id, blocking.requestId, answer)}
            />
          )}
          {chips.length > 0 && (
            <ChipStrip
              chips={chips}
              onRemove={(id) => setChips((c) => c.filter((x) => x.id !== id))}
            />
          )}
          {menu && menuRows.length > 0 && (
            <Typeahead rows={menuRows} active={pick} onHover={setPick} onPick={acceptRow} />
          )}

          <div
            style={{
              padding: '14px 16px 12px',
              background: CHAT.composer,
              border: `1px solid ${focus ? CHAT.border : CHAT.borderComposer}`,
              borderRadius: CHAT.radiusCard,
              boxShadow: '0 8px 30px rgba(0,0,0,.35)',
              transition: 'border-color .16s'
            }}
          >
            {/* The command highlight.
                A textarea holds one flat string and cannot carry a tint, so the
                tint is drawn *behind* it by a twin that lays out the same text
                with the same metrics and paints it transparent — only the
                background of the `/command` run shows through, under the real,
                selectable, editable text. The alternative (a contenteditable
                composer) buys the same pixel at the price of owning caret and
                paste behaviour by hand. */}
            <div style={{ position: 'relative' }}>
              {commandToken && (
                <div
                  ref={overlayRef}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'hidden',
                    pointerEvents: 'none',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'break-word',
                    fontSize: 14.5,
                    lineHeight: 1.55,
                    color: 'transparent'
                  }}
                >
                  {/* Background only — the twin's own glyphs stay transparent,
                      or two layers of the same word would fringe each other. */}
                  <span
                    style={{
                      background: `${CHAT.you}1F`,
                      boxShadow: `inset 0 -1px 0 ${CHAT.you}66`
                    }}
                  >
                    {commandToken}
                  </span>
                  {draft.slice(commandToken.length)}
                </div>
              )}
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => onDraft(e.target.value, e.target.selectionStart)}
                onKeyDown={onKeyDown}
                onFocus={() => setFocus(true)}
                onBlur={() => setFocus(false)}
                // The twin has to follow the box it sits under once the draft is
                // long enough to scroll, or the tint stays at the top while the
                // command it marks has moved off screen.
                onScroll={(e) => {
                  if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop
                }}
                onPaste={(e) => {
                  const items = Array.from(e.clipboardData.files)
                  if (items.length) {
                    e.preventDefault()
                    void addFiles(items)
                  }
                }}
                placeholder={placeholderFor(chat?.open ?? false, !!blocking, working)}
                style={{
                  display: 'block',
                  position: 'relative',
                  width: '100%',
                  minHeight: 26,
                  // Height is driven by the layout effect above; the cap is here so
                  // a 200-line paste scrolls inside the box instead of eating the log.
                  maxHeight: 180,
                  overflowY: 'auto',
                  border: 0,
                  background: 'transparent',
                  color: CHAT.text,
                  fontSize: 14.5,
                  lineHeight: 1.55,
                  padding: 0,
                  resize: 'none',
                  outline: 'none',
                  // The find-bar precedent: a control focused for as long as it
                  // exists has no business lighting the global focus ring.
                  boxShadow: 'none'
                }}
              />
            </div>

            {/* The status line. What you are about to send under, and how to send
                it — both readings the header used to be the only home for. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color: CHAT.dim3
                }}
              >
                {/* Drawn exactly like the header's active chip — same hue on the
                    border and the word, same radius, no fill. The two readings
                    of the mode are far apart on screen, so looking the same is
                    what makes them read as one fact rather than two controls. */}
                <span
                  style={{
                    padding: '2px 7px',
                    border: `1px solid ${mode === 'plan' ? CHAT.mode : CHAT.you}`,
                    borderRadius: CHAT.radius,
                    color: mode === 'plan' ? CHAT.mode : CHAT.you
                  }}
                >
                  {mode === 'plan' ? 'plan' : 'bypass'}
                </span>
                <span>·</span>
                <span>{modelName(chat?.model ?? null)}</span>
              </div>
              <div
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: CHAT.dim4 }}>
                  {working ? 'esc interrupt · ⏎ queue' : '⏎ send · ⇧⏎ newline'}
                </span>
                {/* Mirrors Enter, and the only reason it exists is that Enter is
                    invisible. Interrupt deliberately did *not* take this slot: a
                    button that changes what it does under your cursor mid-turn is
                    how you cancel a turn you meant to send. */}
                <button
                  onClick={send}
                  disabled={!canSend}
                  style={{
                    padding: '7px 16px',
                    border: 0,
                    fontFamily: MONO,
                    fontSize: 11.5,
                    fontWeight: 500,
                    transition: '.14s',
                    background: canSend ? CHAT.you : CHAT.well,
                    color: canSend ? CHAT.onAccent : CHAT.dim2,
                    cursor: canSend ? 'pointer' : 'default'
                  }}
                >
                  send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * `41200` → `41.2k`, `126000` → `126k`. One decimal below 100k, none above: the
 * header reading is a *rate* you watch climb, and rounding 41 200 to `41k` hides
 * every change until the next thousand lands.
 */
function tok(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return k < 100 ? `${Math.round(k * 10) / 10}k` : `${Math.round(k)}k`
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
 * Four readings and two controls, all on one 52px line: the session name and its
 * project on the left, then the context meter, the mode toggle and the model
 * chip on the right.
 *
 * The context reading is three sights of one number — `41.2k / 200k`, a bar, and
 * the percentage the bar's tint is keyed to — because the header is glanced at
 * rather than read: the numbers answer "how much room is left" exactly, the bar
 * answers it in a shape, and the percentage is the one both of the others are
 * approximating. The bar alone is what shipped first and it was unreadable, at
 * 3px against a 1px rule with no scale beside it. It is still not clickable: a
 * click sending /context was genuinely cheap, but it would make a header click
 * *write to the transcript*, which nothing else in the header does.
 *
 * The model chip carries a liveness dot, and that dot is the only green in the
 * chat. It means the CLI process is up — the same fact the app's running
 * indicator means elsewhere, so the colour is not overloaded, it is reused.
 */
function Header({
  session,
  project,
  mode,
  model,
  context,
  live,
  onMode,
  onModelClick,
  onCloseModelMenu,
  modelMenu,
  models,
  onPickModel
}: {
  session: Session
  project: Project
  mode: ChatMode
  model: string | null
  context: ChatContextUsage | null
  /** the chat's process is running — what the dot on the model chip reports */
  live: boolean
  onMode: (m: ChatMode) => void
  onModelClick: () => void
  onCloseModelMenu: () => void
  modelMenu: boolean
  models: ChatModelOption[] | null
  onPickModel: (m: string) => void
}): React.ReactElement {
  const pct = context?.percentage ?? null
  const contextTitle = context
    ? `${tok(context.totalTokens)} / ${tok(context.maxTokens)} tokens · ${context.percentage}% of the context window${context.approximate ? ' (approximate — derived from the turn’s usage)' : ''}`
    : 'Context usage unavailable'

  return (
    <div
      style={{
        flex: 'none',
        // 34, which is `TerminalHost`'s header to the pixel. The two headers
        // occupy the same strip of the window and you switch between them with
        // one click in the sidebar — at 52 the whole page jumped 18px on every
        // switch, and the chat's row was the one that looked wrong, because
        // there is nothing in it a terminal's row does not also carry.
        height: 34,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        // --border's weight, not a hairline: the terminal header takes the same
        // rule for the same reason — the header and the page under it are one
        // surface, and a fainter line simply disappears against them.
        borderBottom: `1px solid ${CHAT.border}`,
        background: CHAT.header
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12.5,
            color: CHAT.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {session.name}
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: CHAT.dim3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {project.name}
        </span>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          title={contextTitle}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontFamily: MONO,
            fontSize: 11,
            color: CHAT.dim2
          }}
        >
          <span style={{ color: CHAT.dim }}>
            {context ? `${tok(context.totalTokens)} / ${tok(context.maxTokens)}` : '— / —'}
          </span>
          {/* A 10px well with its own edge, not a 3px hairline drawn on top of
              hairlines. At 3px against `borderSoft` the empty half of the bar
              carried exactly the weight of the rules it sat between, so the one
              reading in this header meant to be taken at a glance had to be found
              first and then squinted at; and any fill under about 4% had no pixel
              left to draw in, which is precisely the reading where a meter is
              doing its job. The fill keeps a minimum sliver for the same reason —
              "a little" must never render as "none". */}
          <span
            style={{
              width: 68,
              height: 8,
              display: 'block',
              background: CHAT.well,
              border: `1px solid ${CHAT.border}`,
              borderRadius: 4,
              overflow: 'hidden'
            }}
          >
            {pct !== null && (
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.max(pct > 0 ? 6 : 0, Math.min(100, pct))}%`,
                  background: ctxColor(pct),
                  borderRadius: 4,
                  transition: 'width .4s'
                }}
              />
            )}
          </span>
          {/* The percentage in words as well as in length. The bar answers "how
              full" at a glance and this answers "how full exactly" without a
              hover, which is the reading the escalating tint is keyed to. */}
          <span style={{ color: pct === null ? CHAT.dim3 : ctxColor(pct) }}>
            {pct === null ? '—' : `${Math.round(Math.min(100, pct))}%`}
          </span>
        </div>

        {/* Two modes, live — set_permission_mode is accepted mid-conversation and
            even mid-turn. Plain "plan" / "bypass": no warning chrome and no
            explanatory tooltip. Plan mode being advisory here is a known accepted
            property of this tool (terminal agents already run
            --dangerously-skip-permissions), not something the UI argues with the
            user about every time they look at it. */}
        {/* Two separate outlined chips, not a segmented control.
            The hue is carried by the *border and the label*, and nothing is
            filled: a filled chip on this page is a much heavier mark than the
            reading deserves, and it also forced dark ink onto a saturated hue,
            which is the one text colour in the window that could not be read at
            11.5px. Outlining means the two states differ by hue, weight and edge
            at once, and the composer's status chip — outlined already — is drawn
            the same way, so the two places that report the mode now *look* the
            same and not merely agree. Losing the shared box costs nothing: they
            are adjacent, so the gap reads as a pair. */}
        <div style={{ display: 'flex', gap: 6 }}>
          {(['plan', 'bypassPermissions'] as const).map((m) => {
            const active = mode === m
            // A hue per mode, not one hue for "whichever is on". The toggle used
            // the same blue either way, so the only thing telling you which mode
            // you were in was reading the two five-letter words — which is the
            // same failure the log rows had. Blue for plan, coral for bypass, and
            // the composer's status chip already spells it that way, so the two
            // places that report the mode now agree.
            const hue = m === 'plan' ? CHAT.mode : CHAT.you
            return (
              <button
                key={m}
                title={m === 'plan' ? 'Plan first, then approve' : 'Run without asking'}
                onClick={() => onMode(m)}
                style={{
                  padding: '3px 10px',
                  border: `1px solid ${active ? hue : CHAT.border}`,
                  cursor: 'pointer',
                  fontFamily: MONO,
                  fontSize: 11,
                  transition: '.14s',
                  background: 'transparent',
                  color: active ? hue : CHAT.dim2,
                  fontWeight: active ? 500 : 400
                }}
              >
                {m === 'plan' ? 'plan' : 'bypass'}
              </button>
            )
          })}
        </div>

        {/* Anchored to the button it belongs to, not to the header's right edge. */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={onModelClick}
            title={model ? `Model: ${model}` : 'The CLI has not reported a model yet'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              // Sized to the 34px header: every control in this row clears it
              // with a little air, so nothing has to be clipped or centred by eye.
              padding: '3px 9px',
              background: CHAT.well,
              border: `1px solid ${CHAT.border}`,
              color: CHAT.model,
              fontFamily: MONO,
              fontSize: 11,
              cursor: 'pointer',
              transition: 'border-color .14s'
            }}
          >
            <span
              title={live ? 'The CLI process is running' : 'No process — the chat is not open'}
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: live ? CHAT.live : CHAT.dim4
              }}
            />
            <span>{modelName(model)}</span>
            <span style={{ color: CHAT.dim3, fontSize: 9 }}>{modelMenu ? '▲' : '▼'}</span>
          </button>

          {modelMenu && (
            <>
              {/* Click-anywhere-else closes it. A menu you can only dismiss by
                  re-pressing its own button is half of "looks broken". */}
              <div onMouseDown={onCloseModelMenu} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
              <div
                style={{
                  position: 'absolute',
                  top: 34,
                  right: 0,
                  zIndex: 20,
                  background: CHAT.card,
                  border: `1px solid ${CHAT.border}`,
                  borderRadius: CHAT.radiusCard,
                  boxShadow: '0 18px 44px -16px rgba(0,0,0,.7)',
                  minWidth: 232,
                  maxHeight: 300,
                  overflowY: 'auto',
                  animation: 'vpop .12s ease-out'
                }}
              >
                {models === null && (
                  <div style={{ padding: '9px 12px', fontSize: 11.5, fontFamily: MONO, color: CHAT.dim3 }}>
                    loading…
                  </div>
                )}
                {models?.map((m) => {
                  // The chip shows whatever the CLI last reported, which is a
                  // resolved id; the list offers aliases. Matching on either keeps
                  // the tick honest instead of never lighting up.
                  const on = model !== null && (m.value === model || m.detail === model)
                  return (
                    <button
                      key={m.value}
                      onClick={() => onPickModel(m.value)}
                      title={m.detail ?? m.value}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 9,
                        width: '100%',
                        textAlign: 'left',
                        border: 0,
                        borderLeft: `2px solid ${on ? CHAT.model : 'transparent'}`,
                        background: on ? CHAT.hover : 'transparent',
                        color: on ? CHAT.text : CHAT.prose,
                        fontSize: 12.5,
                        padding: '8px 12px',
                        cursor: 'pointer'
                      }}
                    >
                      {/* Derived from the *resolved* id where there is one:
                          `list_models` labels the aliases `Opus` / `Sonnet`,
                          which names the family and hides the generation — the
                          one thing you open this menu to choose between. */}
                      <span style={{ flex: 'none' }}>
                        {modelOptionLabel(m.value, m.label, m.detail)}
                      </span>
                      {m.detail && (
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            color: CHAT.dim3,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {m.detail}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
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
        padding: '8px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard,
        fontFamily: MONO,
        fontSize: 10.5,
        color: CHAT.dim3
      }}
    >
      {todos.map((t) => (
        <span key={t.id} style={{ color: t.status === 'in_progress' ? CHAT.text : undefined }}>
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

  if (card.kind === 'question') {
    return <QuestionCard questions={card.questions ?? []} onAnswer={onAnswer} />
  }

  if (card.kind === 'plan') {
    return (
      <Bar hue={CHAT.hold}>
        <span style={{ fontSize: 13.5, color: CHAT.text }}>Plan awaiting approval</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="revision notes (optional)"
          style={{
            flex: 1,
            minWidth: 80,
            height: 30,
            background: CHAT.well,
            border: `1px solid ${CHAT.border}`,
            color: CHAT.text,
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
    <Bar hue={CHAT.hold}>
      <span style={{ fontSize: 13.5, color: CHAT.text }}>{card.title}</span>
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

/**
 * `AskUserQuestion`'s card — the whole tool, not a row of labels.
 *
 * The first version drew the labels as chips and nothing else, which dropped
 * four of the tool's five affordances on the floor: the option **descriptions**
 * (tooltip-only, so unreadable), the **previews** the model wrote for you to
 * compare, whether the question takes **one answer or several**, the **Other**
 * free-text escape the CLI adds to every question automatically, and **Chat
 * about this**, which is the only way out of a question you would rather talk
 * about than answer. All five are the reason the tool exists; a chip row is the
 * one part of it a plain sentence could have done instead.
 *
 * Layout follows the CLI's own dialog: a vertical option list, and — for a
 * single-select question whose options carry previews — the focused option's
 * preview beside it, with a notes field under it. `focus` is the option the
 * preview is showing and is deliberately *not* the selection: you move through
 * the list to compare, and picking is a separate act.
 */
function QuestionCard({
  questions,
  onAnswer
}: {
  questions: ChatQuestion[]
  onAnswer: (a: ChatAnswer) => void
}): React.ReactElement {
  /** ticked option labels, per question */
  const [picks, setPicks] = React.useState<Record<string, string[]>>({})
  /** the "Other" free text, per question, and whether it is armed */
  const [other, setOther] = React.useState<Record<string, string>>({})
  const [otherOn, setOtherOn] = React.useState<Record<string, boolean>>({})
  /** notes, offered only where the CLI offers them: preview questions */
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  /** which option's preview is on screen — cursor, not selection */
  const [focus, setFocus] = React.useState<Record<string, string>>({})

  const pick = (q: ChatQuestion, label: string): void => {
    setFocus((f) => ({ ...f, [q.question]: label }))
    setPicks((p) => {
      const cur = p[q.question] ?? []
      if (!q.multiSelect) return { ...p, [q.question]: [label] }
      return {
        ...p,
        [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
      }
    })
    // Single-select is exclusive with Other in both directions, or picking an
    // option would silently send a second answer nobody can see.
    if (!q.multiSelect) setOtherOn((o) => ({ ...o, [q.question]: false }))
  }

  const armOther = (q: ChatQuestion): void => {
    setOtherOn((o) => ({ ...o, [q.question]: !o[q.question] }))
    if (!q.multiSelect) setPicks((p) => ({ ...p, [q.question]: [] }))
  }

  /** What this question will send: ticked labels plus a non-empty Other. */
  const valuesFor = (q: ChatQuestion): string[] => {
    const v = [...(picks[q.question] ?? [])]
    const t = (other[q.question] ?? '').trim()
    if (otherOn[q.question] && t) v.push(t)
    return v
  }

  const answersFor = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const q of questions) {
      const v = valuesFor(q)
      // Joined with `", "` rather than sent as an array: that is what the CLI's
      // own dialog submits, and its result builder splits on exactly that
      // string to decide whether every pick was a real option.
      if (v.length > 0) out[q.question] = v.join(', ')
    }
    return out
  }

  const notesFor = (): Record<string, string> | undefined => {
    const out: Record<string, string> = {}
    for (const q of questions) {
      const n = (notes[q.question] ?? '').trim()
      if (n) out[q.question] = n
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  const ready = questions.every((q) => valuesFor(q).length > 0)

  return (
    <Bar hue={CHAT.hold} column>
      {/* The card can outgrow the space above the composer — four questions with
          previews is a legal call — so it scrolls itself rather than pushing the
          composer off screen. The right padding keeps the `choose one` hint out
          from under that scrollbar. */}
      <div
        style={{ maxHeight: '46vh', overflowY: 'auto', paddingRight: 8, display: 'grid', gap: 16 }}
      >
        {questions.map((q) => {
          const withPreview = !q.multiSelect && q.options.some((o) => o.preview)
          const shown = focus[q.question] ?? q.options[0]?.label
          const chosen = picks[q.question] ?? []
          const list = (
            <div
              style={{
                display: 'grid',
                gap: 4,
                alignContent: 'start',
                // Without a preview column beside it the list would run the full
                // 880px measure, so a two-word label wore an 800px highlight.
                maxWidth: withPreview ? undefined : 620
              }}
            >
              {q.options.map((o) => (
                <OptionRow
                  key={o.label}
                  label={o.label}
                  description={o.description}
                  multi={q.multiSelect}
                  on={chosen.includes(o.label)}
                  focused={withPreview && shown === o.label}
                  onFocus={() => setFocus((f) => ({ ...f, [q.question]: o.label }))}
                  onClick={() => pick(q, o.label)}
                />
              ))}
              {/* Always present, because the CLI always adds it: "There should be
                  no 'Other' option, that will be provided automatically" is in
                  the schema the model is handed. Its text *is* the answer — the
                  dialog files it under the question like any label. */}
              <OptionRow
                label="Other"
                description="answer in your own words"
                multi={q.multiSelect}
                on={!!otherOn[q.question]}
                focused={false}
                onClick={() => armOther(q)}
              />
              {otherOn[q.question] && (
                <input
                  autoFocus
                  value={other[q.question] ?? ''}
                  onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && ready) {
                      e.preventDefault()
                      onAnswer({ behavior: 'question', answers: answersFor(), notes: notesFor() })
                    }
                  }}
                  placeholder="Type something…"
                  style={{
                    marginLeft: 22,
                    height: 28,
                    background: CHAT.well,
                    border: `1px solid ${CHAT.border}`,
                    color: CHAT.text,
                    fontSize: 12.5,
                    padding: '0 9px',
                    outline: 'none'
                  }}
                />
              )}
            </div>
          )

          return (
            <div key={q.question}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 9,
                  marginBottom: 8,
                  flexWrap: 'wrap'
                }}
              >
                {q.header && (
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      letterSpacing: '.04em',
                      textTransform: 'uppercase',
                      padding: '2px 6px',
                      border: `1px solid ${CHAT.border}`,
                      color: CHAT.hold,
                      flex: 'none'
                    }}
                  >
                    {q.header}
                  </span>
                )}
                <span style={{ fontSize: 13.5, color: CHAT.text, flex: 1, minWidth: 0 }}>
                  {q.question}
                </span>
                {/* Whether more than one answer is allowed is not derivable from
                    the options, and getting it wrong is a silently wrong answer
                    rather than a visible error. */}
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: CHAT.dim3, flex: 'none' }}>
                  {q.multiSelect ? 'choose any' : 'choose one'}
                </span>
              </div>

              {withPreview ? (
                <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14 }}>
                  {list}
                  <div style={{ minWidth: 0, display: 'grid', gap: 8, alignContent: 'start' }}>
                    {/* Markdown in a **monospace** box. The window root already
                        declares mono; this says it again on purpose, because
                        the CLI's own preview pane is Ink — a terminal grid
                        whatever the model wrote — and the tool's schema promises
                        the model that grid. A wrapper that ever restyles this
                        window must not quietly reflow an ASCII mockup. */}
                    {/* **Every option's preview is laid out, in one grid cell,
                        and all but the focused one are hidden.** The box is
                        therefore as tall and as wide as the *tallest* preview
                        from the moment it appears, and moving down the list
                        cannot change its size by a pixel.

                        Rendering only the focused one is what the obvious
                        version does, and it made the whole window flicker: a
                        five-line preview after a twenty-line one shrinks the
                        card, the log's ResizeObserver reads that as the scroller
                        having changed height and re-pins the tail — so merely
                        *hovering* the options jumped the conversation. Reserving
                        the space up front is the fix, and it needs no pixel
                        arithmetic against the font metrics to get right.

                        Sideways it scrolls; vertically it grows and the card's
                        own scroller takes it, since a second scroller nested in
                        that one would swallow the wheel halfway down a mockup. */}
                    <div
                      style={{
                        display: 'grid',
                        overflowX: 'auto',
                        padding: '8px 12px',
                        background: CHAT.well,
                        border: `1px solid ${CHAT.borderCard}`,
                        borderRadius: CHAT.radiusCard
                      }}
                    >
                      {q.options.map((o) => (
                        <div
                          key={o.label}
                          style={{
                            gridArea: '1 / 1',
                            visibility: shown === o.label ? 'visible' : 'hidden'
                          }}
                        >
                          {o.preview ? (
                            <Preview src={o.preview} />
                          ) : (
                            <span style={{ fontFamily: MONO, fontSize: 11.5, color: CHAT.dim3 }}>
                              no preview for this option
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <input
                      value={notes[q.question] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [q.question]: e.target.value }))}
                      placeholder="Notes on this option (optional)…"
                      style={{
                        height: 28,
                        background: CHAT.well,
                        border: `1px solid ${CHAT.border}`,
                        color: CHAT.text,
                        fontSize: 12.5,
                        padding: '0 9px',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>
              ) : (
                list
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <div style={{ flex: 1 }} />
        {/* Not a cancel. It denies the tool with the questions attached and a
            note that the user wants to talk first, so the composer message you
            type next lands in a turn that is already listening. */}
        <button
          onClick={() =>
            onAnswer({
              behavior: 'question',
              answers: answersFor(),
              notes: notesFor(),
              clarify: true
            })
          }
          style={secondaryButton}
        >
          Chat about this
        </button>
        <button
          disabled={!ready}
          onClick={() =>
            // The answers map is keyed by question *text*: an `allow` without one
            // yields "The user did not answer the questions." with no error
            // raised anywhere, which would silently break the card.
            onAnswer({ behavior: 'question', answers: answersFor(), notes: notesFor() })
          }
          style={primaryButton(!ready)}
        >
          Answer
        </button>
      </div>
    </Bar>
  )
}

/**
 * One selectable option. The marker carries the *arity* — a box for a
 * multi-select, a radio for a single — so "choose any" is legible from the
 * control as well as from the words beside the question.
 */
function OptionRow({
  label,
  description,
  multi,
  on,
  focused,
  onFocus,
  onClick
}: {
  label: string
  description?: string
  multi: boolean
  on: boolean
  focused: boolean
  onFocus?: () => void
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onFocus}
      onFocus={onFocus}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '5px 8px',
        border: `1px solid ${on ? CHAT.hold : focused ? CHAT.border : 'transparent'}`,
        borderRadius: CHAT.radius,
        background: on ? 'rgba(194,161,94,.16)' : focused ? CHAT.hover : 'transparent',
        color: on ? CHAT.text : CHAT.dim,
        cursor: 'pointer'
      }}
    >
      <span
        style={{ fontFamily: MONO, fontSize: 11.5, color: on ? CHAT.hold : CHAT.dim3, flex: 'none' }}
      >
        {multi ? (on ? '[x]' : '[ ]') : on ? '(•)' : '( )'}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 12.5, color: on ? CHAT.text : CHAT.prose }}>{label}</span>
        {description && (
          <span style={{ fontSize: 11.5, color: CHAT.dim3, marginLeft: 8 }}>{description}</span>
        )}
      </span>
    </button>
  )
}

function Bar({
  hue,
  column = false,
  children
}: {
  hue: string
  /** stacked rather than a single row — what a question card needs */
  column?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        flexDirection: column ? 'column' : 'row',
        alignItems: column ? 'stretch' : 'center',
        gap: column ? 0 : 13,
        padding: '11px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderTop: `2px solid ${hue}`,
        borderRadius: CHAT.radiusCard
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
    background: disabled ? CHAT.well : CHAT.you,
    color: disabled ? CHAT.dim2 : CHAT.onAccent,
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer'
  }
}

// Drawn from CHAT, not from the app's slate custom properties: this palette is
// deliberately its own so it cannot leak *out*, and `var(--border)` on a control
// inside the chat window is the same mistake pointing inwards — a near-black
// panel wearing the sidebar's hairline.
const secondaryButton: React.CSSProperties = {
  flex: 'none',
  height: 32,
  padding: '0 17px',
  border: `1px solid ${CHAT.border}`,
  background: 'transparent',
  color: CHAT.dim,
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
        gap: 3,
        padding: '8px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard
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
            fontSize: 11,
            color: c.ok ? CHAT.dim : CHAT.danger
          }}
        >
          <span style={{ flex: 'none' }}>{c.ok ? (c.attachment.kind === 'image' ? '▣' : '≡') : '⚠'}</span>
          <span style={{ color: CHAT.text }}>{c.ok ? c.attachment.name : c.name}</span>
          <span style={{ flex: 1, minWidth: 0, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.ok ? c.detail : c.reason}
          </span>
          <button
            onClick={() => onRemove(c.id)}
            style={{
              flex: 'none',
              border: 0,
              background: 'transparent',
              color: CHAT.dim3,
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

/** One row of either typeahead. `node` is what marks it as a file rather than a command. */
export interface TypeaheadRow {
  key: string
  /** what is inserted, and what is shown in the bright column */
  name: string
  detail?: string
  node?: MountNode
}

/**
 * The rows behind the composer's two typeaheads.
 *
 * The `/` list is `slash_commands[]` + `skills[]`, showing **name and source
 * only** — `init` carries names and nothing else, so there are no descriptions,
 * no argument-hints, no per-command forms. Picking inserts `/name ` and
 * dismisses; everything after is free text, including the second `/foo` in
 * `/loop 5m /foo`. The composer never parses a command: every `/…` is forwarded
 * verbatim and whatever happens next is Claude Code's business, which is what
 * keeps this from rotting as the CLI ships new commands.
 *
 * Prefix matches sort first. Typing `co` means you are reaching for something
 * that *starts* `co`, and burying `compact` under `add-dir` because the latter
 * happens to contain the letters is what makes a list feel like it is not
 * listening.
 */
function typeaheadRows(
  menu: { kind: 'slash' | 'at'; query: string },
  commands: string[],
  tree: MountNode[]
): TypeaheadRow[] {
  const q = menu.query.toLowerCase()
  if (menu.kind === 'slash') {
    // Deduped: `init` reports `slash_commands[]` and `skills[]` separately and
    // the two overlap (`code-review`, `update-config` are both), so the raw
    // concatenation lists them twice — and React, keying on the name, warns
    // about it. One name is one row whichever list it came from; the CLI
    // decides what it means, exactly as the never-parse rule says.
    return [...new Set(commands.map((c) => c.replace(/^\//, '')))]
      .filter((c) => c.toLowerCase().includes(q))
      .sort((a, b) => {
        const rank = (s: string): number => (s.toLowerCase().startsWith(q) ? 0 : 1)
        return rank(a) - rank(b) || a.localeCompare(b)
      })
      .slice(0, 12)
      .map((c) => ({ key: c, name: `/${c}` }))
  }
  return flattenTree(tree)
    .filter((n) => n.type === 'file' && n.name.toLowerCase().includes(q))
    .slice(0, 12)
    .map((n) => ({ key: n.containerPath, name: n.name, detail: n.containerPath, node: n }))
}

/**
 * The list itself: rows, one highlight, and a line saying how to drive it.
 *
 * The highlight is `active`, which the composer owns — the keyboard and the
 * mouse move the same selection, so hovering row four and pressing Tab twice
 * takes row four rather than whatever the keyboard was pointing at privately.
 */
function Typeahead({
  rows,
  active,
  onHover,
  onPick
}: {
  rows: TypeaheadRow[]
  active: number | null
  onHover: (i: number) => void
  onPick: (row: TypeaheadRow) => void
}): React.ReactElement {
  return (
    <div
      style={{
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard,
        overflow: 'hidden'
      }}
    >
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {rows.map((r, i) => {
          const on = i === active
          return (
            <button
              key={r.key}
              onMouseMove={() => onHover(i)}
              onMouseDown={(e) => {
                // mousedown, not click: a blur would close this before the click.
                e.preventDefault()
                onPick(r)
              }}
              style={{
                display: 'flex',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                border: 0,
                borderLeft: `2px solid ${on ? CHAT.you : 'transparent'}`,
                background: on ? CHAT.hover : 'transparent',
                color: CHAT.dim,
                fontFamily: MONO,
                fontSize: 11.5,
                padding: '6px 14px',
                cursor: 'pointer'
              }}
            >
              <span style={{ color: on ? CHAT.text : CHAT.prose }}>{r.name}</span>
              {r.detail && (
                <span
                  style={{
                    color: CHAT.dim3,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {r.detail}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {/* The same argument as the composer's own footer: Tab and the arrows are
          free affordances that nobody can find, so they are written down once
          where they apply. */}
      <div
        style={{
          borderTop: `1px solid ${CHAT.borderSoft}`,
          padding: '4px 14px',
          fontFamily: MONO,
          fontSize: 10,
          color: CHAT.dim4
        }}
      >
        {active === null ? 'tab · ↑↓ select' : 'tab · ⏎ insert · ↑↓ next · esc dismiss'}
      </div>
    </div>
  )
}
