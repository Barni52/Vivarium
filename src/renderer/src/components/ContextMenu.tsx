import React from 'react'
import { useStore } from '../state/store'

// xterm instances keyed by session id (registered in TerminalView). Typed to
// the minimal focus/blur surface we need here so we don't import xterm.
type FocusableTerm = { focus(): void; blur(): void }
function selectedTerm(): FocusableTerm | undefined {
  const id = useStore.getState().selectedSessionId
  if (!id) return undefined
  const terms = (window as unknown as { __vivTerms?: Record<string, FocusableTerm> }).__vivTerms
  return terms?.[id]
}

// Single app-wide, dark-themed context menu driven by the store. Positioned at
// the cursor (clamped to the viewport) and closed on select / outside click /
// Escape / scroll / blur.
export function ContextMenu(): React.ReactElement | null {
  const menu = useStore((s) => s.contextMenu)
  const close = useStore((s) => s.closeContextMenu)
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)

  // measure then clamp into the viewport
  React.useLayoutEffect(() => {
    if (!menu) {
      setPos(null)
      return
    }
    const el = ref.current
    const w = el?.offsetWidth ?? 220
    const h = el?.offsetHeight ?? 0
    const left = Math.min(menu.x, window.innerWidth - w - 6)
    const top = Math.min(menu.y, window.innerHeight - h - 6)
    setPos({ left: Math.max(6, left), top: Math.max(6, top) })
  }, [menu])

  // Opening a menu must take focus away from the terminal — xterm otherwise
  // keeps DOM focus and keystrokes would leak into it while the menu is up.
  React.useEffect(() => {
    if (menu) selectedTerm()?.blur()
  }, [menu])

  React.useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const onClose = menu.onClose
        close()
        if (onClose) requestAnimationFrame(onClose) // return focus to the terminal
      }
    }
    // Capture phase, because scroll doesn't bubble: this is how a scrolled
    // *element* dismisses the menu, not just the window. That reach is also the
    // catch — a terminal scrolls its own viewport every time output arrives, and
    // every session of a running container has a live xterm (hidden ones
    // included), so an agent printing anything used to close the menu a second
    // or two after it opened, in whatever project happened to be talking. Only
    // the user scrolling the menu's anchor out from under it is worth a dismiss,
    // so terminals are excluded; the full-screen catcher below means user
    // scrolling can only reach a surface layered above it anyway.
    const onScroll = (e: Event): void => {
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest('[data-terminal-host]')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu, close])

  if (!menu) return null

  const hasIcons = menu.items.some((item) => !!item.icon)

  return (
    // full-screen catcher closes on any outside click (incl. right-click)
    <div
      onClick={(e) => {
        const { clientX, clientY } = e
        close()
        // The catcher swallowed this click, so if it landed in a terminal the
        // xterm never focused. After the catcher unmounts (next frame), focus
        // the visible terminal so the user can type into it immediately.
        requestAnimationFrame(() => {
          const el = document.elementFromPoint(clientX, clientY)
          if (el?.closest('[data-terminal-host]')) selectedTerm()?.focus()
        })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        close()
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
    >
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: pos?.left ?? menu.x,
          top: pos?.top ?? menu.y,
          minWidth: 190,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          boxShadow: '0 18px 44px -16px rgba(0,0,0,.7)',
          animation: 'vpop .12s ease',
          padding: 4,
          visibility: pos ? 'visible' : 'hidden'
        }}
      >
        {menu.items.map((item, i) =>
          item.label === '---' ? (
            <div key={i} style={{ height: 1, background: 'var(--border-2)', margin: '4px 6px' }} />
          ) : (
            <MenuRow
              key={i}
              label={item.label}
              icon={item.icon}
              hint={item.hint}
              // one left edge for the labels: as soon as one item in this menu
              // brings a glyph, the iconless ones keep an empty slot rather than
              // sliding under the icons
              gutter={hasIcons}
              danger={item.danger}
              disabled={item.disabled}
              onSelect={() => {
                if (item.disabled) return
                const onClose = menu.onClose
                close()
                item.onSelect?.()
                // Restore terminal focus after the action + catcher unmount, so
                // e.g. Paste leaves you able to type without clicking again.
                if (onClose) requestAnimationFrame(onClose)
              }}
            />
          )
        )}
      </div>
    </div>
  )
}

function MenuRow({
  label,
  icon,
  hint,
  gutter,
  danger,
  disabled,
  onSelect
}: {
  label: string
  icon?: React.ReactNode
  hint?: string
  gutter?: boolean
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const color = disabled ? 'var(--text-3)' : danger ? 'var(--danger)' : 'var(--text)'
  // Glyphs sit one step below the label in brightness (and brighten with the
  // row): they're there to be recognised at a glance, not read — a full-strength
  // icon column would out-shout the words it's labelling.
  const iconColor = disabled
    ? 'var(--text-3)'
    : danger
      ? 'var(--danger)'
      : hover
        ? 'var(--text-2)'
        : 'var(--text-3)'
  // Non-danger hover uses the selection color (--sel) — the old --row-hover was
  // nearly indistinguishable from the panel background. Danger keeps its red tint.
  const bg = hover && !disabled ? (danger ? 'rgba(250,77,86,.14)' : 'var(--sel)') : 'transparent'
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        height: 30,
        padding: '0 12px',
        fontSize: 13,
        color,
        background: bg,
        cursor: disabled ? 'default' : 'pointer',
        userSelect: 'none',
        opacity: disabled ? 0.6 : 1
      }}
    >
      {gutter && (
        <span
          style={{
            width: 16,
            height: 16,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: iconColor
          }}
        >
          {icon}
        </span>
      )}
      {label}
      {hint && (
        // Pushed to the right edge with a guaranteed gap, so a long label never
        // collides with its chord.
        <span
          style={{
            marginLeft: 'auto',
            paddingLeft: 18,
            fontSize: 11.5,
            color: 'var(--text-3)',
            fontFamily: "'IBM Plex Mono', monospace",
            flex: 'none'
          }}
        >
          {hint}
        </span>
      )}
    </div>
  )
}
