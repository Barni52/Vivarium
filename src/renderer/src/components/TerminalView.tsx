import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import type { Project, Session } from '@shared/types'
import { useStore } from '../state/store'
import { Chevron, Close, Copy, Paste, Refresh, Search, SelectAll, ZoomIn, ZoomOut } from './Icons'

// Windows console "Campbell" ANSI palette — makes colored program output
// (PSReadLine highlighting, git, ls, npm, etc.) render the way it does in a
// real Windows terminal instead of xterm's washed-out defaults.
const CAMPBELL = {
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#3b78ff',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#6aa9ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2'
}

// All session types share the app's dark terminal background.
const DARK_THEME = {
  background: '#0a0d12',
  foreground: '#c7cfda',
  cursor: '#c7cfda',
  selectionBackground: 'rgba(69,137,255,.32)',
  ...CAMPBELL
}

// The bits of xterm's internals we have to reach for: its scrollbar geometry and
// its wheel-delta maths. Both are explained where they're used below; neither is
// reachable through the public API in 5.5.
type XtermCore = {
  viewport?: {
    syncScrollArea?(immediate: boolean): void
    getLinesScrolled?(ev: WheelEvent): number
    _lastRecordedBufferLength?: number
  }
}
const core = (term: Terminal): XtermCore | undefined =>
  (term as unknown as { _core?: XtermCore })._core

/**
 * Recompute the scrollbar geometry from scratch, right now.
 *
 * xterm's scrollback bar is a real DOM scrollbar: `.xterm-scroll-area` is sized
 * to the whole buffer and the wheel moves the viewport's own scrollTop. That
 * height is recalculated inside a requestAnimationFrame — and a rAF never runs
 * while the window is producing no frames (minimized, or fully covered by
 * another window), which is exactly when an agent streams output nobody is
 * watching. xterm records "I've accounted for this buffer length" *before*
 * queueing that frame, so when the agent then falls silent — the moment you come
 * back to read it — the terminal is left with a scroll area one screen tall in
 * front of thousands of unreachable lines, and nothing will ever notice.
 *
 * Its own `syncScrollArea` can't get us out of that: it is change *detection*
 * (buffer length, canvas height, scroll position, cell height, all against what
 * it last recorded) and in this state every one of them matches. So drop one of
 * the records first — a length of -1 can never match a real one — and the sync
 * recomputes. `immediate` skips the animation frame that got us here.
 *
 * A real resize does the same thing via `_afterResize`, which is why zooming in
 * and out appeared to repair it.
 */
function forceScrollAreaSync(term: Terminal): void {
  const vp = core(term)?.viewport
  if (!vp) return
  vp._lastRecordedBufferLength = -1
  vp.syncScrollArea?.(true)
}

/**
 * The height of one row, measured off the DOM instead of read from xterm.
 *
 * xterm's own copy of this lives on the *renderer's* dimensions object, which
 * the viewport caches by reference and only replaces when an onDimensionsChange
 * fires. Swap the renderer (WebGL context loss → the DOM fallback below) without
 * also changing size and no such event is emitted, so the viewport keeps sizing
 * the scrollbar from a dead object. `.xterm-screen` is sized to rows × cell
 * height by whichever renderer is actually live, so it can't go stale that way.
 */
function rowHeight(term: Terminal): number {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen || term.rows < 1) return 0
  return screen.clientHeight / term.rows
}

/**
 * Repair the scroll geometry, but only when it is provably broken: the DOM
 * scrollbar cannot reach every line the buffer is holding above the view. Cheap
 * enough to call on every wheel gesture, and because it does nothing in the
 * healthy case it can't fight a scroll that is working.
 *
 * This is the belt to forceScrollAreaSync's braces: Windows doesn't necessarily
 * mark a merely *occluded* window as hidden, so there may be no visibilitychange
 * to hang the repair on — but there is always the notch the user is about to
 * waste.
 *
 * The test is "short of the buffer", not "cannot scroll at all", because a stale
 * scroll area is not only ever one screen tall. Resize a window whose bar has
 * gone stale and the viewport shrinks under a scroll area that didn't follow:
 * a bar reappears, reaching exactly as far back as the taller window had shown
 * and no further, and the old zero-range test called that healthy and left it
 * there. In the healthy case the two sides are equal — a full buffer is
 * baseY + rows lines and the area is baseY rows taller than the viewport — so
 * the slack is a single row of rounding, no more.
 */
function repairIfStuck(term: Terminal): boolean {
  const vpEl = term.element?.querySelector('.xterm-viewport')
  const px = rowHeight(term)
  if (!vpEl || !px) return false
  const needed = term.buffer.active.baseY * px
  const reachable = vpEl.scrollHeight - vpEl.clientHeight
  if (reachable >= needed - px) return false
  forceScrollAreaSync(term)
  return true
}

/** xterm's own wheel-delta → lines math (it accumulates sub-line touchpad
 *  deltas, so a slow trackpad still scrolls). ~3 lines a notch if it ever goes. */
function wheelLines(term: Terminal, ev: WheelEvent): number {
  const n = core(term)?.viewport?.getLinesScrolled?.(ev)
  return typeof n === 'number' && !Number.isNaN(n) ? n : Math.sign(ev.deltaY) * 3
}

// A terminal narrower/shorter than this isn't a terminal, it's a collapsed box
// mid-layout. FitAddon clamps to 2x1 rather than refusing, so it has to be us
// who refuses (see fitNow).
const MIN_FIT_W = 40
const MIN_FIT_H = 30

/**
 * Match highlighting for the find bar. xterm composites these itself and only
 * accepts plain #RRGGBB here — no alpha — so they are pre-mixed against the
 * terminal background instead of reusing the translucent selection blue.
 * The overview-ruler entries are required by the type but inert: that ruler only
 * draws when `overviewRulerWidth` is set, which it isn't.
 */
const SEARCH_OPTS: ISearchOptions = {
  decorations: {
    matchBackground: '#2c3c52',
    matchBorder: '#3d5271',
    matchOverviewRuler: '#5a769f',
    activeMatchBackground: '#5a769f',
    activeMatchBorder: '#93aacb',
    activeMatchColorOverviewRuler: '#c7cfda'
  }
}

// One long-lived xterm bound to a single session's pty. It is created once and
// never destroyed on selection change — only hidden — so scrollback survives
// switching (plan: TerminalHost). Visibility is driven by `visible`.
export function TerminalView({
  project,
  session,
  visible
}: {
  project: Project
  session: Session
  visible: boolean
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  // the guarded fit (see fitNow below) — every resize path goes through it
  const fitNowRef = React.useRef<() => void>(() => {})
  const visibleRef = React.useRef(visible)
  visibleRef.current = visible
  const setLive = useStore((s) => s.setLive)
  const setActivity = useStore((s) => s.setActivity)

  // --- find bar (Ctrl+F) ---
  // The addon is reached through a ref because the key handler that opens the
  // bar is installed once, inside the mount effect; only the bar's own state has
  // to live in React.
  const searchRef = React.useRef<SearchAddon | null>(null)
  const findInputRef = React.useRef<HTMLInputElement>(null)
  const [find, setFind] = React.useState({ open: false, term: '', caseSensitive: false })
  const [results, setResults] = React.useState({ index: -1, count: 0 })
  // Mirror, so the callbacks below and the key handler installed once at mount
  // can read the current term without being rebuilt on every keystroke.
  const findRef = React.useRef(find)
  findRef.current = find

  const closeFind = React.useCallback((): void => {
    setFind((f) => ({ ...f, open: false }))
    searchRef.current?.clearDecorations() // don't leave highlights behind
    termRef.current?.focus()
  }, [])

  /** Jump to the next/previous match for the current term. */
  const stepFind = React.useCallback((back: boolean): void => {
    const search = searchRef.current
    const { term, caseSensitive } = findRef.current
    if (!search || !term) return
    const opts = { ...SEARCH_OPTS, caseSensitive }
    if (back) search.findPrevious(term, opts)
    else search.findNext(term, opts)
  }, [])

  // --- create the terminal + pty once ---
  React.useEffect(() => {
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: useStore.getState().terminalFontSize,
      // Keep lineHeight at the default 1.0 so the WebGL cell height stays
      // integer-aligned — a fractional line height left the last row partially
      // clipped at the bottom edge.
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'bar',
      scrollback: 50000,
      allowProposedApi: true,
      rightClickSelectsWord: false,
      // Real IBM Plex Mono weights (preloaded in main.tsx) so the renderer never
      // fakes a weight by double-drawing glyphs (smeared text). Normal is 500
      // (medium) rather than 400 — at small sizes 400 reads as thin/faint.
      fontWeight: 500,
      fontWeightBold: 700,
      theme: DARK_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)

    // Search over the scrollback. The match highlighting — and the counter that
    // rides on its onDidChangeResults event — is proposed API, which this
    // terminal already opts into (allowProposedApi above).
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    const resultsSub = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount })
    )

    // Ctrl+F, from the key handler installed further down or the context menu.
    const openFind = (): void => {
      // Seed from the selection: the common case is "I highlighted this, now
      // show me the next one". Multi-line selections aren't search terms.
      const sel = term.getSelection()
      setFind((f) => ({ ...f, open: true, term: sel && !sel.includes('\n') ? sel : f.term }))
      // If the bar was already open its input is mounted, so select the term the
      // way a browser's find does; if it wasn't, autoFocus handles the first
      // frame and this is a no-op.
      requestAnimationFrame(() => findInputRef.current?.select())
    }

    // --- the one way to resize this terminal -------------------------------
    // Two guards have to hold on every resize path, so they all come through
    // here:
    //
    //  1. Never fit a box with no usable size. FitAddon clamps to its own
    //     MINIMUM_COLS/ROWS (2x1) instead of refusing, so a container that is
    //     momentarily collapsed — output panel dragged to the top, a very short
    //     window, a layout pass mid-drag — resizes the terminal to a one-row
    //     sliver and tells the pty it has one row, which is enough to make an
    //     agent's TUI redraw itself into that sliver and stay corrupt. A
    //     collapsed *width* is worse: 2 columns reflows the entire 50k-line
    //     scrollback and the buffer never gets its line structure back.
    //
    //  2. Only tell the pty when the size really changed. fit() no-ops when the
    //     dimensions match but resizeSession doesn't, and this used to be called
    //     unconditionally — a single zoom sent five SIGWINCHes in 400ms and made
    //     the TUI repaint five times.
    let sent = { cols: 0, rows: 0 }
    const fitNow = (): void => {
      const host = hostRef.current
      if (!host || host.clientWidth < MIN_FIT_W || host.clientHeight < MIN_FIT_H) return
      try {
        fit.fit()
      } catch {
        /* cell metrics not measurable yet */
      }
      if (term.cols !== sent.cols || term.rows !== sent.rows) {
        sent = { cols: term.cols, rows: term.rows }
        window.vivarium.resizeSession(session.id, term.cols, term.rows)
      }
      // a resize is also the moment the scrollbar geometry has to be right
      forceScrollAreaSync(term)
    }
    fitNowRef.current = fitNow

    // WebGL gives one GL context per terminal, and they are not free: Chromium
    // drops the *oldest* context once a page holds too many, and a GPU driver
    // reset (routine on Windows) takes them all out at once. That first case is
    // reachable now that every session of a running container is mounted rather
    // than only the ones you clicked — a couple of dozen sessions and the earliest
    // terminals get their contexts taken. It degrades rather than breaks, which is
    // the whole point of the handler below. xterm waits 3s for
    // a restore and then gives up via onContextLoss — and a renderer that has
    // given up simply stops painting, which is the terminal that "breaks" and
    // won't come back. Dropping the addon falls back to the DOM renderer:
    // slower, but it always draws.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        fitNow()
        term.refresh(0, term.rows - 1)
      })
      term.loadAddon(webgl)
    } catch {
      /* WebGL unavailable — fall back to the DOM renderer */
    }
    fitNow()
    termRef.current = term
    // debug handle for automated smoke tests (read scrollback via xterm's API)
    const terms = ((window as unknown as { __vivTerms?: Record<string, Terminal> }).__vivTerms ??= {})
    terms[session.id] = term

    // keystrokes → pty
    const dataSub = term.onData((data) => window.vivarium.writeSession(session.id, data))

    // pty → terminal (also carries container build/create output before the pty exists)
    const offData = window.vivarium.onPtyData((e) => {
      if (e.sessionId === session.id) term.write(e.data)
    })
    const offExit = window.vivarium.onPtyExit((e) => {
      if (e.sessionId === session.id) {
        setLive(session.id, false)
        setActivity(session.id, 'idle')
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
      }
    })
    // container lifecycle output (from the project power button) — only the
    // visible terminal of the matching project surfaces it.
    const offCO = window.vivarium.onContainerOutput((e) => {
      if (e.projectId === project.id && visibleRef.current) term.write(e.data)
    })

    // --- clipboard: copy / paste / SIGINT -------------------------------
    // xterm does none of this on its own, so wire it explicitly (the Electron
    // default menu has no clipboard roles on Windows). Conventions match
    // Windows Terminal: Ctrl+C copies when there's a selection else sends
    // SIGINT; Ctrl+V / Shift+Insert paste; Ctrl+Shift+C/V force copy/paste.
    const doCopy = (): void => {
      const sel = term.getSelection()
      if (sel) {
        window.vivarium.clipboardWriteText(sel)
        term.clearSelection()
      }
    }
    const doPaste = async (): Promise<void> => {
      // agents: a clipboard image becomes a mounted file path (replaces the
      // reference TCP bridge); otherwise paste text.
      if (session.type === 'agent') {
        const imgPath = await window.vivarium.pasteImage(project.id)
        if (imgPath) {
          window.vivarium.writeSession(session.id, imgPath + ' ')
          return
        }
      }
      const text = await window.vivarium.clipboardReadText()
      if (text) term.paste(text) // routes through onData → pty, honoring bracketed paste
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const k = e.key.toLowerCase()
      // The working/idle indicator is driven by Claude Code hook events (see
      // main/bridge.ts), but the Stop hook does not fire on a user interrupt —
      // so an Esc in an agent terminal optimistically resets the indicator
      // (no notification; the user is right here). Esc still reaches the pty.
      if (session.type === 'agent' && e.key === 'Escape') {
        setActivity(session.id, 'idle')
        return true
      }
      // Claude Code: Shift+Enter and Ctrl+Enter insert a newline instead of
      // submitting. xterm sends a bare CR for Enter regardless of modifiers, so
      // translate these chords to ESC+CR — the sequence Claude Code treats as
      // "insert newline" (the same one `claude`'s /terminal-setup installs for
      // Shift+Enter). Plain Enter still submits.
      //
      // preventDefault is essential for Shift+Enter specifically: returning
      // false from the keydown handler makes xterm skip its default, but it
      // doesn't mark the event handled, so the browser still fires a follow-up
      // `keypress` (charCode 13) that xterm would send as a second, bare CR —
      // appending our newline AND submitting. preventDefault suppresses that
      // keypress. (Ctrl+Enter emits no keypress, which is why it already
      // worked.)
      if (session.type === 'agent' && e.key === 'Enter' && (e.shiftKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault()
        window.vivarium.writeSession(session.id, '\x1b\r')
        return false
      }
      // zoom: Ctrl +/-/0 (Windows Terminal / VS Code convention)
      if (e.ctrlKey && !e.altKey) {
        if (e.key === '=' || e.key === '+') {
          useStore.getState().zoomTerminal(1)
          return false
        }
        if (e.key === '-') {
          useStore.getState().zoomTerminal(-1)
          return false
        }
        if (e.key === '0') {
          useStore.getState().resetTerminalZoom()
          return false
        }
      }
      // Ctrl+F opens the find bar. This does take the chord from the shell
      // (readline's forward-char, which the arrow keys already cover) — a
      // deliberate trade against 50k lines of agent scrollback that previously
      // had no way to be searched at all. Ctrl+Shift+F does the same, for
      // Windows Terminal muscle memory.
      if (e.ctrlKey && !e.altKey && k === 'f') {
        openFind()
        return false
      }
      // Ctrl+Backspace → delete the previous word. xterm emits nothing useful
      // for this chord on its own, so translate it to the byte each shell's
      // line editor treats as backward-kill-word:
      //   • bash (readline): ESC+DEL (M-DEL) → backward-kill-word, which stops
      //     at punctuation (nicer than Ctrl+W's whitespace-only unix-word-rubout).
      //   • PowerShell (PSReadLine) + Claude Code: Ctrl+W (0x17) → BackwardKillWord.
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Backspace') {
        window.vivarium.writeSession(session.id, session.type === 'container-shell' ? '\x1b\x7f' : '\x17')
        return false
      }
      // force copy / paste
      if (e.ctrlKey && e.shiftKey && k === 'c') {
        doCopy()
        return false
      }
      if ((e.ctrlKey && e.shiftKey && k === 'v') || (e.shiftKey && e.key === 'Insert')) {
        // preventDefault, or the browser's own paste action still fires a native
        // `paste` event on xterm's hidden textarea, which xterm forwards to the
        // pty as a second copy (same trap as Shift+Enter above). Chromium treats
        // Ctrl+Shift+V ("paste as plain text") and Shift+Insert as paste too.
        e.preventDefault()
        void doPaste()
        return false
      }
      if (e.ctrlKey && e.key === 'Insert') {
        doCopy()
        return false
      }
      // Ctrl+C: copy a selection, else fall through so ^C reaches the pty (SIGINT)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'c') {
        if (term.hasSelection()) {
          doCopy()
          return false
        }
        return true
      }
      // Ctrl+V: paste (preventDefault — see the Ctrl+Shift+V branch above)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'v') {
        e.preventDefault()
        void doPaste()
        return false
      }
      return true
    })

    // right-click: show a context menu
    const el = term.element
    const onContext = (ev: MouseEvent): void => {
      ev.preventDefault()
      const z = useStore.getState()
      z.openContextMenu(
        ev.clientX,
        ev.clientY,
        [
          {
            label: 'Copy',
            icon: <Copy size={14} />,
            hint: 'Ctrl+C',
            disabled: !term.hasSelection(),
            onSelect: () => doCopy()
          },
          { label: 'Paste', icon: <Paste size={14} />, hint: 'Ctrl+V', onSelect: () => void doPaste() },
          { label: 'Select all', icon: <SelectAll size={14} />, onSelect: () => term.selectAll() },
          { label: '---' },
          // The plain lens of the magnifier family the zoom items use below.
          { label: 'Find…', icon: <Search size={14} />, hint: 'Ctrl+F', onSelect: () => openFind() },
          { label: '---' },
          { label: 'Zoom in', icon: <ZoomIn size={14} />, hint: 'Ctrl++', onSelect: () => z.zoomTerminal(1) },
          { label: 'Zoom out', icon: <ZoomOut size={14} />, hint: 'Ctrl+-', onSelect: () => z.zoomTerminal(-1) },
          // a circular arrow rather than a third magnifier: "back to the default"
          // is the action, and a magnifier with nothing in it now means Find
          {
            label: 'Reset zoom',
            icon: <Refresh size={14} />,
            hint: 'Ctrl+0',
            onSelect: () => z.resetTerminalZoom()
          }
          // No "Clear" here: xterm's clear() drops the entire 50k-line
          // scrollback, which made it the only irreversible action in a menu of
          // harmless ones — one row below Paste, with no confirmation. The
          // shell's own `clear`/`cls` is still right there for anyone who wants
          // a clean screen.
        ],
        // restore focus to this terminal when the menu closes (item / Escape),
        // so pasting or any action leaves the user able to type immediately
        () => term.focus()
      )
    }
    el?.addEventListener('contextmenu', onContext)

    // Ctrl + mouse wheel zooms the terminal
    const onWheel = (ev: WheelEvent): void => {
      if (!ev.ctrlKey) return
      ev.preventDefault()
      useStore.getState().zoomTerminal(ev.deltaY < 0 ? 1 : -1)
    }
    el?.addEventListener('wheel', onWheel, { passive: false })

    // --- who owns the wheel ------------------------------------------------
    // The moment an application turns on mouse tracking (`CSI ?1000h` and
    // friends) xterm stops scrolling its viewport and forwards wheel notches to
    // that application as button reports instead. It decides this *before*
    // consulting any custom wheel handler, so the only way in is a capture
    // listener above it.
    //
    // That is why an agent terminal can suddenly refuse to scroll back: the
    // Claude Code binary ships `?1000h`/`?1006h`, and while tracking is on the
    // scrollback is unreachable with the wheel no matter how much of it there is.
    //
    // So: in the NORMAL buffer the wheel is the user's, tracking or not — a
    // wheel over a log of output means scroll the log, and an app that only
    // wanted clicks loses nothing. In the ALTERNATE buffer (vim, less, htop) it
    // stays the application's: there is no scrollback to reach there, and those
    // apps really do use it.
    const onWheelCapture = (ev: WheelEvent): void => {
      if (ev.ctrlKey) return // zoom, handled above
      // A wasted notch is how the user discovers a stale scrollbar, so this is
      // the place to notice it. Having just repaired the geometry we also scroll
      // this notch ourselves: the repair snaps the viewport back to the buffer
      // position, and the browser would coalesce that with the user's own scroll
      // into one event which xterm then ignores — losing the notch that found
      // the bug.
      const repaired = repairIfStuck(term)
      if (!repaired) {
        if (term.modes.mouseTrackingMode === 'none') return // xterm scrolls it fine
        if (term.buffer.active.type === 'alternate') return // the app's wheel
      }
      ev.preventDefault()
      ev.stopPropagation() // keep it away from xterm's mouse reporting
      term.scrollLines(wheelLines(term, ev))
    }
    hostRef.current?.addEventListener('wheel', onWheelCapture, {
      capture: true,
      passive: false
    })

    // --- open the pty ------------------------------------------------------
    // This never starts the container: main refuses to (see ipc.ts openSession),
    // the user starts it explicitly and TerminalHost mounts this view once it is
    // up. Container build/create output still streams in through onContainerOutput
    // above, so a cold start is visible here.
    //
    // Why this retries: mounting is what opens a pty, and a container coming up
    // now mounts *every* one of its sessions at once. Main re-checks
    // `docker inspect` per open, and isRunning() reads any non-zero exit as
    // "stopped" — so under that burst one of them can be told the container is
    // stopped when it plainly isn't. A single attempt left that terminal dark for
    // good, because nothing remounts it while the store still says running. So
    // retry the transient answers for as long as the store disagrees with them,
    // and only report failure once we've stopped trying.
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const openPty = async (attempt: number): Promise<void> => {
      const res = await window.vivarium.openSession(project.id, session.id, term.cols, term.rows)
      if (cancelled) return
      if (res.ok) {
        setLive(session.id, true)
        return
      }
      const transient = res.reason === 'container-stopped' || res.reason === 'spawn-failed'
      const stillUp = !!useStore.getState().states[project.id]?.running
      if (transient && stillUp && attempt < 3) {
        retry = setTimeout(() => void openPty(attempt + 1), 700 * 2 ** (attempt - 1))
        return
      }
      // Out of attempts: `live` may still be true from the pty this view replaced
      // (a cross-project move kills that one silently), so clear it — otherwise
      // TerminalHost keeps a dead terminal mounted on the strength of it.
      setLive(session.id, false)
      if (res.reason === 'docker-missing') {
        term.write('\r\n\x1b[31mdocker not found on PATH — start Docker/Rancher Desktop.\x1b[0m\r\n')
      } else if (res.reason === 'container-stopped') {
        // The TerminalHost placeholder normally covers this; a state race can
        // still land here.
        term.write('\r\n\x1b[2mcontainer is stopped — start it to open this session.\x1b[0m\r\n')
      } else {
        term.write('\r\n\x1b[31mfailed to open session.\x1b[0m\r\n')
      }
    }
    void openPty(1)

    // debounced resize on element/window size changes (~100ms) — the TUI
    // corrupts without this (plan: Resize papercut).
    let t: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(fitNow, 100)
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(hostRef.current!)
    window.addEventListener('resize', doFit)

    // Coming back from minimized/occluded: the frames xterm's scrollbar sync
    // waits for have not been running (see forceScrollAreaSync), so put the
    // geometry right the moment the window is on screen again rather than
    // leaving the user to find dead scrollback and reach for the zoom.
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      fitNow()
      forceScrollAreaSync(term)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      dataSub.dispose()
      resultsSub.dispose()
      searchRef.current = null
      offData()
      offExit()
      offCO()
      el?.removeEventListener('contextmenu', onContext)
      el?.removeEventListener('wheel', onWheel)
      hostRef.current?.removeEventListener('wheel', onWheelCapture, { capture: true })
      ro.disconnect()
      window.removeEventListener('resize', doFit)
      document.removeEventListener('visibilitychange', onVisible)
      if (t) clearTimeout(t)
      term.dispose()
      termRef.current = null
    }
    // project.id is in here because a session can be moved to another project:
    // TerminalHost keys this view on the pair, so the change remounts and this
    // effect re-execs into the new container.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, project.id])

  // --- on becoming visible: refit + resize the pty + focus ---
  React.useEffect(() => {
    if (!visible) return
    const term = termRef.current
    if (!term) return
    // next frame so the div has non-zero size after visibility flips
    const raf = requestAnimationFrame(() => {
      fitNowRef.current()
      // fitNow syncs the geometry too, but it refuses a box with no usable size
      // and returns before it gets there — and the frame the user starts reading
      // a terminal on is the one frame its scrollbar has to be right. Repairing
      // separately costs nothing when nothing is wrong.
      repairIfStuck(term)
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, session.id])

  // --- run the search as the term / options change ---
  React.useEffect(() => {
    const search = searchRef.current
    if (!search || !find.open) return
    if (!find.term) {
      search.clearDecorations()
      setResults({ index: -1, count: 0 })
      return
    }
    // incremental keeps the current match while the term is being extended,
    // instead of hopping to the next one on every keystroke
    search.findNext(find.term, {
      ...SEARCH_OPTS,
      caseSensitive: find.caseSensitive,
      incremental: true
    })
  }, [find.open, find.term, find.caseSensitive])

  // --- apply terminal zoom (global font size) + refit ---
  const fontSize = useStore((s) => s.terminalFontSize)
  React.useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    // The new cell metrics are available synchronously on the line above — the
    // renderer has already resized its canvas to rows × the *new* cell height,
    // which overflows the container until the fit brings the row count back in
    // line. So fit immediately: this is the gap where a zoom left the terminal
    // drawing outside its box with the bottom rows clipped. (This used to be a
    // spray of five fits over 400ms on the theory that the metrics settled
    // asynchronously — they don't, and each of those fits resized the pty and
    // made the TUI repaint.)
    fitNowRef.current()
    // One more next frame, in case the font itself was still loading and the
    // first measurement was of a fallback face. fitNow is a no-op when nothing
    // changed, so this costs nothing when it wasn't needed.
    const raf = requestAnimationFrame(() => fitNowRef.current())
    return () => cancelAnimationFrame(raf)
  }, [fontSize, session.id])

  // Outer div carries the gutter padding + background; xterm opens into the
  // INNER (unpadded) div so the FitAddon measures the real content area and
  // never overflows into the padding (which overflow:hidden would then clip).
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: '10px 14px 12px 16px',
        overflow: 'hidden',
        background: 'var(--terminal-bg)',
        visibility: visible ? 'visible' : 'hidden'
      }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      {find.open && (
        <FindBar
          state={find}
          results={results}
          inputRef={findInputRef}
          onTerm={(term) => setFind((f) => ({ ...f, term }))}
          onToggleCase={() => setFind((f) => ({ ...f, caseSensitive: !f.caseSensitive }))}
          onStep={stepFind}
          onClose={closeFind}
        />
      )}
    </div>
  )
}

/**
 * Floating find bar. Absolutely positioned on purpose: anything that took layout
 * space here would change the terminal's size, and every size change resizes the
 * pty and makes a TUI repaint (see fitNow). It sits clear of xterm's scrollbar,
 * which owns the last ~10px before the right gutter.
 */
function FindBar({
  state,
  results,
  inputRef,
  onTerm,
  onToggleCase,
  onStep,
  onClose
}: {
  state: { term: string; caseSensitive: boolean }
  results: { index: number; count: number }
  inputRef: React.RefObject<HTMLInputElement>
  onTerm: (term: string) => void
  onToggleCase: () => void
  onStep: (back: boolean) => void
  onClose: () => void
}): React.ReactElement {
  const empty = !state.term
  const none = !empty && results.count === 0
  // The addon reports index -1 once the highlight limit is passed — say "1000+"
  // rather than a position it can't actually track.
  const counter = empty
    ? ''
    : none
      ? 'no results'
      : results.index >= 0
        ? `${results.index + 1}/${results.count}`
        : `${results.count}+`

  return (
    <div
      // Wheel/context events here belong to the bar, not to the terminal
      // underneath it.
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 8,
        right: 26,
        zIndex: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 32,
        padding: '0 4px 0 9px',
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        boxShadow: '0 12px 30px -14px rgba(0,0,0,.8)'
      }}
    >
      <span style={{ display: 'flex', color: 'var(--text-3)', flex: 'none' }}>
        <Search size={13} />
      </span>
      <input
        ref={inputRef}
        value={state.term}
        autoFocus
        spellCheck={false}
        placeholder="Find in terminal"
        onChange={(e) => onTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
          // Ctrl+F while the bar is already up re-selects the term, as a
          // browser's find does, instead of doing nothing.
          if (e.ctrlKey && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            inputRef.current?.select()
          }
        }}
        style={{
          width: 158,
          height: 24,
          background: 'transparent',
          border: 0,
          color: 'var(--text)',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12.5,
          padding: 0,
          outline: 'none',
          // Opts out of the global focus ring: this input is focused for as long
          // as the bar exists, so a ring says nothing, and its bloom crowds a
          // 32px-tall bar. The buttons beside it still ring, so Tab stays
          // traceable.
          boxShadow: 'none'
        }}
      />
      <span
        style={{
          minWidth: 58,
          textAlign: 'right',
          fontSize: 11,
          fontFamily: "'IBM Plex Mono', monospace",
          color: none ? 'var(--danger)' : 'var(--text-3)',
          flex: 'none'
        }}
      >
        {counter}
      </span>
      <FindBtn title="Match case" active={state.caseSensitive} onClick={onToggleCase}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.3px' }}>Aa</span>
      </FindBtn>
      <FindBtn title="Previous match (Shift+Enter)" onClick={() => onStep(true)}>
        <Chevron size={13} style={{ transform: 'rotate(-90deg)' }} />
      </FindBtn>
      <FindBtn title="Next match (Enter)" onClick={() => onStep(false)}>
        <Chevron size={13} style={{ transform: 'rotate(90deg)' }} />
      </FindBtn>
      <FindBtn title="Close (Esc)" onClick={onClose}>
        <Close size={12} />
      </FindBtn>
    </div>
  )
}

function FindBtn({
  title,
  active,
  onClick,
  children
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // The bar lives inside the terminal, so a click here must not pull DOM
      // focus off the input the user is typing into.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        width: 24,
        height: 24,
        flex: 'none',
        border: 0,
        background: active ? 'var(--sel)' : hover ? 'var(--field-2)' : 'transparent',
        color: active ? 'var(--text)' : hover ? 'var(--text)' : 'var(--text-2)',
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
