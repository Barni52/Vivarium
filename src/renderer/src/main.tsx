import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
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
      document.fonts.load("13px 'IBM Plex Mono'"),
      document.fonts.load("500 13px 'IBM Plex Mono'"),
      document.fonts.load("700 13px 'IBM Plex Mono'"),
      document.fonts.load("14px 'IBM Plex Sans'")
    ])
    await document.fonts.ready
  } catch {
    /* fonts API unavailable — render anyway */
  }
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
