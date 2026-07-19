import React from 'react'

// Small shared dialog primitives styled from the mockup.

export const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--overlay)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: 64,
  zIndex: 40,
  animation: 'vover .12s ease'
}

export function Overlay({
  onClose,
  children,
  center
}: {
  onClose: () => void
  children: React.ReactNode
  center?: boolean
}): React.ReactElement {
  return (
    <div
      onClick={onClose}
      style={{
        ...overlayStyle,
        alignItems: center ? 'center' : 'flex-start',
        paddingTop: center ? 0 : 64
      }}
    >
      {children}
    </div>
  )
}

export function Panel({
  width = 560,
  children
}: {
  width?: number
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width,
        maxWidth: 'calc(100vw - 40px)',
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        boxShadow: '0 24px 60px -20px rgba(0,0,0,.7)',
        animation: 'vdlg .16s ease',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'calc(100vh - 110px)'
      }}
    >
      {children}
    </div>
  )
}

export const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-2)' }

export function fieldStyle(mono?: boolean): React.CSSProperties {
  return {
    height: 40,
    background: 'var(--field)',
    border: 0,
    borderBottom: '1px solid var(--text-3)',
    color: 'var(--text)',
    fontFamily: mono ? "'IBM Plex Mono', monospace" : 'inherit',
    fontSize: mono ? 13 : 14,
    padding: '0 12px',
    outline: 'none'
  }
}

export function FooterButton({
  primary,
  danger,
  onClick,
  children,
  height = 52
}: {
  primary?: boolean
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
  height?: number
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const bg = danger
    ? hover
      ? '#da1e28'
      : 'var(--danger)'
    : primary
      ? hover
        ? 'var(--accent-2)'
        : 'var(--accent)'
      : hover
        ? 'var(--field)'
        : 'transparent'
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        height,
        border: 0,
        background: bg,
        color: primary || danger ? '#fff' : 'var(--text-2)',
        fontSize: 14,
        fontWeight: primary || danger ? 500 : 400,
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}

export function ImageToggle({
  value,
  onChange
}: {
  value: 'slim' | 'full'
  onChange: (v: 'slim' | 'full') => void
}): React.ReactElement {
  const cell = (active: boolean): React.CSSProperties => ({
    flex: 1,
    border: 0,
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--text-2)',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 500
  })
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border)', height: 40 }}>
      <button style={cell(value === 'slim')} onClick={() => onChange('slim')}>
        Slim
      </button>
      <button style={{ ...cell(value === 'full'), borderLeft: '1px solid var(--border)' }} onClick={() => onChange('full')}>
        Full
      </button>
    </div>
  )
}
