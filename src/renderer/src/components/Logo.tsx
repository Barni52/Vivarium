import React from 'react'

// The Vivarium app mark, matching build/icon.svg (the Windows icon): a dark
// app-tile holding a container (lid bar + open box) with the agent sparkle
// glowing inside. Rendered inline as SVG so it stays crisp at any size. Gradient
// ids are made unique per instance (React.useId) so several logos can coexist on
// one page without url(#id) collisions.
export function Logo({
  size = 32,
  rounded = true,
  style
}: {
  size?: number
  /** draw the rounded app-tile background; false = glyph only (transparent) */
  rounded?: boolean
  style?: React.CSSProperties
}): React.ReactElement {
  const uid = React.useId().replace(/:/g, '')
  const bg = `bg-${uid}`
  const spark = `spark-${uid}`
  const glow = `glow-${uid}`
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" style={style}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="256" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1D2230" />
          <stop offset="1" stopColor="#12151D" />
        </linearGradient>
        <linearGradient id={spark} x1="128" y1="106" x2="128" y2="174" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#CBB2FF" />
          <stop offset="1" stopColor="#9A75F0" />
        </linearGradient>
        <radialGradient id={glow} cx="128" cy="140" r="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9C7BF2" stopOpacity="0.55" />
          <stop offset="1" stopColor="#9C7BF2" stopOpacity="0" />
        </radialGradient>
      </defs>

      {rounded && (
        <>
          <rect x="8" y="8" width="240" height="240" rx="54" fill={`url(#${bg})`} />
          <rect
            x="8.75"
            y="8.75"
            width="238.5"
            height="238.5"
            rx="53.25"
            stroke="#FFFFFF"
            strokeOpacity="0.06"
            strokeWidth="1.5"
          />
        </>
      )}

      {/* container lid */}
      <rect x="60" y="70" width="136" height="16" rx="8" fill="#AEB5CC" />

      {/* container body (open-topped box) */}
      <path
        d="M74 94 L74 160 Q74 188 102 188 L154 188 Q182 188 182 160 L182 94"
        stroke="#AEB5CC"
        strokeWidth="13"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* agent sparkle */}
      <circle cx="128" cy="140" r="44" fill={`url(#${glow})`} />
      <path
        d="M128 108 Q133 135 155 140 Q133 145 128 172 Q123 145 101 140 Q123 135 128 108 Z"
        fill={`url(#${spark})`}
      />
    </svg>
  )
}
