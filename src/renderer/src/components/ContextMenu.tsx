import React from 'react'
import { useStore } from '../state/store'

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

  React.useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    // capture-phase scroll so scrolling anything dismisses the menu
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu, close])

  if (!menu) return null

  return (
    // full-screen catcher closes on any outside click (incl. right-click)
    <div
      onClick={close}
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
              danger={item.danger}
              disabled={item.disabled}
              onSelect={() => {
                if (item.disabled) return
                close()
                item.onSelect?.()
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
  danger,
  disabled,
  onSelect
}: {
  label: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const color = disabled ? 'var(--text-3)' : danger ? 'var(--danger)' : 'var(--text)'
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
      {label}
    </div>
  )
}
