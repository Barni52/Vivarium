import React from 'react'
import { PanelToggle } from './Icons'
import { Logo } from './Logo'
import { useStore } from '../state/store'

// Frameless custom title bar (mockup lines 308-322). The bar is draggable via
// -webkit-app-region; buttons opt out so they stay clickable.
const drag: React.CSSProperties = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function WinButton({
  onClick,
  hoverBg,
  hoverColor,
  children
}: {
  onClick: () => void
  hoverBg: string
  hoverColor?: string
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 46,
        border: 0,
        background: hover ? hoverBg : 'transparent',
        color: hover && hoverColor ? hoverColor : 'var(--text-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
        ...noDrag
      }}
    >
      {children}
    </button>
  )
}

export function TitleBar(): React.ReactElement {
  const v = window.vivarium
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const [toggleHover, setToggleHover] = React.useState(false)
  return (
    <div
      style={{
        height: 32,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--win)',
        borderBottom: '1px solid var(--border-2)',
        userSelect: 'none',
        paddingLeft: 10,
        ...drag
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <button
          title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={toggleSidebar}
          onMouseEnter={() => setToggleHover(true)}
          onMouseLeave={() => setToggleHover(false)}
          style={{
            width: 28,
            height: 24,
            border: 0,
            background: toggleHover ? 'var(--row-hover)' : 'transparent',
            color: collapsed ? 'var(--text-2)' : 'var(--accent-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            borderRadius: 4,
            ...noDrag
          }}
        >
          <PanelToggle />
        </button>
        <Logo size={18} style={{ flex: 'none' }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '.3px' }}>Vivarium</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>session manager</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'stretch', height: 32 }}>
        <WinButton onClick={() => v.windowMinimize()} hoverBg="var(--row-hover)">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WinButton>
        <WinButton onClick={() => v.windowMaximize()} hoverBg="var(--row-hover)">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
          </svg>
        </WinButton>
        <WinButton onClick={() => v.windowClose()} hoverBg="#da1e28" hoverColor="#fff">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WinButton>
      </div>
    </div>
  )
}
