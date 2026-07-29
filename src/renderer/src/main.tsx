import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
// Plex Mono is the fallback in MONO (theme.ts), so it has to be loaded too —
// the whole point of naming a bundled fallback is that it is actually present.
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/700.css'
import '@xterm/xterm/css/xterm.css'

import { createRoot } from 'react-dom/client'
import { App } from './App'
import { GLOBAL_CSS } from './theme'

const style = document.createElement('style')
style.textContent = GLOBAL_CSS
document.head.appendChild(style)

// Preload the terminal font (regular + bold) BEFORE the first xterm builds its
// WebGL glyph atlas. Otherwise the atlas caches a fallback / synthesizes bold by
// double-drawing, which renders as smeared/doubled text.
async function boot(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load("13px 'JetBrains Mono'"),
      document.fonts.load("500 13px 'JetBrains Mono'"),
      document.fonts.load("700 13px 'JetBrains Mono'"),
      document.fonts.load("14px 'IBM Plex Sans'")
    ])
    await document.fonts.ready
  } catch {
    /* fonts API unavailable — render anyway */
  }
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
