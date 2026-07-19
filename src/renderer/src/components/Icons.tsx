// SVG icons ported from the design mockup (scratchpad/page.html).
import React from 'react'

type P = { size?: number; color?: string; style?: React.CSSProperties }

const svg = (size: number, children: React.ReactNode, style?: React.CSSProperties): React.ReactElement => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={style}>
    {children}
  </svg>
)

export const Sparkle = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <path d="M8 1.5l1.5 4.4 4.4 1.6-4.4 1.6L8 13.5 6.5 9.1 2.1 7.5 6.5 5.9z" fill={color} />, style)

export const Folder = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path
      d="M1.6 4.4A1 1 0 012.6 3.4h3l1.2 1.4h6.6a1 1 0 011 1v6.2a1 1 0 01-1 1H2.6a1 1 0 01-1-1z"
      stroke={color}
      strokeWidth="1.1"
    />,
    style
  )

export const Chevron = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path d="M6 4l4 4-4 4" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
    style
  )

export const Terminal = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <path d="M3.5 5l2.6 3-2.6 3M8.2 11h4.3" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
    style
  )

export const Plus = ({ size = 16, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <path d="M8 3v10M3 8h10" stroke={color} strokeWidth="1.5" strokeLinecap="round" />, style)

// A proper toothed cog: 8 flat-topped trapezoidal teeth (radial sides + flat
// tips) around a hollow hub. Built procedurally so the teeth are evenly spaced
// and geometrically exact — reads as a gear at small sizes, unlike thin spokes.
const GEAR_PATH = ((): string => {
  const cx = 8
  const cy = 8
  const teeth = 8
  const rTip = 6.7 // tooth tip radius
  const rRoot = 4.9 // valley radius between teeth
  const step = (Math.PI * 2) / teeth
  const half = step * 0.28 // angular half-width of each tooth
  const pt = (ang: number, r: number): string =>
    `${(cx + Math.cos(ang) * r).toFixed(2)} ${(cy + Math.sin(ang) * r).toFixed(2)}`
  let d = ''
  for (let i = 0; i < teeth; i++) {
    const c = i * step
    d += `${i === 0 ? 'M' : 'L'}${pt(c - half, rRoot)}L${pt(c - half, rTip)}L${pt(
      c + half,
      rTip
    )}L${pt(c + half, rRoot)}`
  }
  return `${d}Z`
})()

export const Gear = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d={GEAR_PATH} stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2.3" stroke={color} strokeWidth="1.1" />
    </>,
    style
  )

export const Stop = ({ size = 12, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <rect x="4" y="4" width="8" height="8" rx="1" fill={color} />, style)

export const Restart = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d="M13 5A5.2 5.2 0 103.4 8.4" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13.2 2.2v3h-3" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </>,
    style
  )

export const Pencil = ({ size = 13, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <path d="M10.8 2.6l2.6 2.6-7.5 7.5H3.3v-2.6z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />, style)

export const Close = ({ size = 13, color = 'currentColor', style }: P): React.ReactElement =>
  svg(size, <path d="M4 4l8 8M12 4l-8 8" stroke={color} strokeWidth="1.4" strokeLinecap="round" />, style)

export const Trash = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d="M2.5 4.5h11M6 4.5V3.2a1 1 0 011-1h2a1 1 0 011 1v1.3" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
      <path d="M3.8 4.5l.6 8a1 1 0 001 .95h5.2a1 1 0 001-.95l.6-8" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 7v4M9.5 7v4" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    </>,
    style
  )

export const Lock = ({ size = 12, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke={color} strokeWidth="1.1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke={color} strokeWidth="1.1" />
    </>,
    style
  )

export const GitBranch = ({ size = 12, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <circle cx="4.5" cy="3.5" r="1.6" stroke={color} strokeWidth="1.15" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke={color} strokeWidth="1.15" />
      <circle cx="11.5" cy="4.5" r="1.6" stroke={color} strokeWidth="1.15" />
      <path d="M4.5 5.1v5.8M6.1 4.5h2.4a1.5 1.5 0 011.5 1.5v.4M11.5 6.1c0 2.2-1.6 3.2-3.5 3.6" stroke={color} strokeWidth="1.15" strokeLinecap="round" />
    </>,
    style
  )

export const File = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path
        d="M4 2.2h5l3 3v8.6H4z"
        stroke={color}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M9 2.2v3h3" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
    </>,
    style
  )

export const Refresh = ({ size = 14, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <path d="M12.5 5A5.2 5.2 0 103.2 8" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M12.7 2.2v3h-3" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </>,
    style
  )

export const PanelToggle = ({ size = 15, color = 'currentColor', style }: P): React.ReactElement =>
  svg(
    size,
    <>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.2" stroke={color} strokeWidth="1.2" />
      <path d="M6.2 2.8v10.4" stroke={color} strokeWidth="1.2" />
    </>,
    style
  )

export function TypeIcon({ type, size = 15, color }: { type: string; size?: number; color?: string }): React.ReactElement {
  return type === 'agent' ? <Sparkle size={size} color={color} /> : <Terminal size={size} color={color} />
}
