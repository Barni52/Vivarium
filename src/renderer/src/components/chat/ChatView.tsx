import React from 'react'
import type {
  ChatAnswer,
  ChatBlockingCard,
  ChatContextUsage,
  ChatEntry,
  ChatMode,
  ChatModelOption,
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
  const streamingId = React.useMemo(() => {
    if (!working) return null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'text' && e.role === 'claude') return e.id
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
            composer's column carries the same factor, so the two stay aligned. */}
        <div
          ref={contentRef}
          style={{ zoom, maxWidth: MEASURE, margin: '0 auto', padding: '26px 24px 40px' }}
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
        <div style={{ zoom, maxWidth: MEASURE, margin: '0 auto', position: 'relative' }}>
          {/* The pinned bands, widest scope to narrowest, each absent entirely
              when empty. Nothing is ever hidden by something else — letting a
              pending card displace the todo strip was rejected, because it does
              not make the buttons more visible (they are adjacent either way) and
              it costs a disappearance the user did not cause. */}
          {todos.length > 0 && <TodoStrip todos={todos} />}
          {blocking && (
            <BlockingBar
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
                <span
                  style={{
                    padding: '2px 7px',
                    border: `1px solid ${mode === 'plan' ? `${CHAT.mode}55` : `${CHAT.you}55`}`,
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
                    background: canSend ? CHAT.you : '#1A2029',
                    color: canSend ? CHAT.bg : CHAT.dim2,
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
 * The context reading leads with the numbers (`41.2k / 200k`) and the bar is the
 * afterthought beside them — the reverse of what shipped, which was a bare 8px
 * bar with no scale, floating against nothing. It is still not clickable: a click
 * sending /context was genuinely cheap, but it would make a header click *write
 * to the transcript*, which nothing else in the header does.
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
        height: 52,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 20px',
        borderBottom: `1px solid ${CHAT.borderSoft}`,
        background: CHAT.header
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 13,
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
            gap: 9,
            fontFamily: MONO,
            fontSize: 10.5,
            color: CHAT.dim2
          }}
        >
          <span>
            {context ? `${tok(context.totalTokens)} / ${tok(context.maxTokens)}` : '— / —'}
          </span>
          <span style={{ width: 56, height: 3, background: CHAT.borderSoft, display: 'block' }}>
            {pct !== null && (
              <span
                style={{
                  display: 'block',
                  height: 3,
                  width: `${Math.min(100, pct)}%`,
                  background: ctxColor(pct),
                  transition: 'width .4s'
                }}
              />
            )}
          </span>
        </div>

        {/* Two modes, live — set_permission_mode is accepted mid-conversation and
            even mid-turn. Plain "plan" / "bypass": no warning chrome and no
            explanatory tooltip. Plan mode being advisory here is a known accepted
            property of this tool (terminal agents already run
            --dangerously-skip-permissions), not something the UI argues with the
            user about every time they look at it. */}
        <div style={{ display: 'flex', border: `1px solid ${CHAT.border}` }}>
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
                  padding: '6px 13px',
                  border: 0,
                  cursor: 'pointer',
                  fontFamily: MONO,
                  fontSize: 11.5,
                  transition: '.14s',
                  background: active ? hue : 'transparent',
                  color: active ? CHAT.bg : '#6B7480',
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
              gap: 8,
              padding: '6px 10px',
              background: '#131820',
              border: `1px solid ${CHAT.border}`,
              color: CHAT.model,
              fontFamily: MONO,
              fontSize: 11.5,
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
                        background: on ? 'rgba(255,255,255,.03)' : 'transparent',
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
      <Bar hue={CHAT.hold}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {questions.map((q) => (
            <div key={q.question} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 13, color: CHAT.text, marginBottom: 6 }}>{q.question}</div>
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
                        fontSize: 11.5,
                        padding: '5px 11px',
                        border: `1px solid ${on ? CHAT.hold : CHAT.border}`,
                        background: on ? 'rgba(194,161,94,.12)' : 'transparent',
                        color: on ? CHAT.text : CHAT.dim,
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
            background: CHAT.bg,
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

function Bar({ hue, children }: { hue: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '11px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`,
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
    background: disabled ? '#1A2029' : CHAT.you,
    color: disabled ? CHAT.dim2 : CHAT.bg,
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
        gap: 3,
        padding: '8px 14px',
        marginBottom: 10,
        background: CHAT.card,
        border: `1px solid ${CHAT.borderCard}`
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
        border: `1px solid ${CHAT.borderCard}`
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
                background: on ? 'rgba(255,255,255,.04)' : 'transparent',
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
