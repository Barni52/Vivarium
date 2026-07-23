import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Project, Session } from '@shared/types'
import { useStore } from '../state/store'

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
  const fitRef = React.useRef<FitAddon | null>(null)
  const visibleRef = React.useRef(visible)
  visibleRef.current = visible
  const setLive = useStore((s) => s.setLive)
  const setActivity = useStore((s) => s.setActivity)

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
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* WebGL unavailable — fall back to the canvas renderer */
    }
    fit.fit()
    termRef.current = term
    fitRef.current = fit
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
      // Ctrl+V: paste
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'v') {
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
          { label: 'Copy', disabled: !term.hasSelection(), onSelect: () => doCopy() },
          { label: 'Paste', onSelect: () => void doPaste() },
          { label: 'Select all', onSelect: () => term.selectAll() },
          { label: '---' },
          { label: 'Zoom in', onSelect: () => z.zoomTerminal(1) },
          { label: 'Zoom out', onSelect: () => z.zoomTerminal(-1) },
          { label: 'Reset zoom', onSelect: () => z.resetTerminalZoom() },
          { label: '---' },
          { label: 'Clear', onSelect: () => term.clear() }
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

    // open the pty (starts/builds the container if needed; output streams above)
    ;(async () => {
      const res = await window.vivarium.openSession(project.id, session.id, term.cols, term.rows)
      if (res.ok) {
        setLive(session.id, true)
      } else if (res.reason === 'docker-missing') {
        term.write('\r\n\x1b[31mdocker not found on PATH — start Docker/Rancher Desktop.\x1b[0m\r\n')
      } else if (res.reason === 'container-stopped') {
        // The container isn't running — the TerminalHost placeholder normally
        // covers this, but a state race can still land here. Don't auto-start.
        term.write('\r\n\x1b[2mcontainer is stopped — start it to open this session.\x1b[0m\r\n')
      } else if (res.reason === 'container-failed') {
        term.write('\r\n\x1b[31mcontainer failed to start (see output above).\x1b[0m\r\n')
      } else {
        term.write('\r\n\x1b[31mfailed to open session.\x1b[0m\r\n')
      }
    })()

    // debounced resize on element/window size changes (~100ms) — the TUI
    // corrupts without this (plan: Resize papercut).
    let t: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        try {
          fit.fit()
          window.vivarium.resizeSession(session.id, term.cols, term.rows)
        } catch {
          /* not visible / zero-size */
        }
      }, 100)
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(hostRef.current!)
    window.addEventListener('resize', doFit)

    return () => {
      dataSub.dispose()
      offData()
      offExit()
      offCO()
      el?.removeEventListener('contextmenu', onContext)
      el?.removeEventListener('wheel', onWheel)
      ro.disconnect()
      window.removeEventListener('resize', doFit)
      if (t) clearTimeout(t)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // --- on becoming visible: refit + resize the pty + focus ---
  React.useEffect(() => {
    if (!visible) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    // next frame so the div has non-zero size after visibility flips
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
        window.vivarium.resizeSession(session.id, term.cols, term.rows)
        term.focus()
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, session.id])

  // --- apply terminal zoom (global font size) + refit ---
  const fontSize = useStore((s) => s.terminalFontSize)
  React.useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    // xterm recomputes its cell metrics asynchronously after a font-size change,
    // so re-fit a few times over ~400ms — the later fits land once the new cell
    // size has settled and correct the cols/rows (a single early fit is stale).
    const doFit = (): void => {
      try {
        fit.fit()
        window.vivarium.resizeSession(session.id, term.cols, term.rows)
      } catch {
        /* not visible / zero-size */
      }
    }
    const timers = [0, 60, 140, 260, 400].map((ms) => setTimeout(doFit, ms))
    return () => timers.forEach(clearTimeout)
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
    </div>
  )
}
