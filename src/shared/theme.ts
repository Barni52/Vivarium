/**
 * The one part of the palette that is a cross-process fact.
 *
 * Almost all of the theme is CSS and therefore renderer-only — it lives in
 * `src/renderer/src/theme.ts`, which is where the token maps and every argument
 * about them are. This module exists because exactly two values escape that
 * boundary:
 *
 *   - **the theme's name**, which the renderer persists and the main process
 *     never sees, but which types the map below;
 *   - **the page colour**, which `BrowserWindow.backgroundColor` paints *under*
 *     the document — the frame before the renderer has drawn anything, and the
 *     edge you are dragging during a resize. Main has no document, no CSS and no
 *     access to the renderer's `localStorage`, so it cannot resolve `var(--bg)`
 *     and cannot know which theme is on.
 *
 * Main therefore opens the window on `THEME_BG[DEFAULT_THEME]` and the renderer
 * corrects it over `window:set-background` during module eval, before
 * `ready-to-show` reveals anything. Both halves read this table, so the value is
 * still written down exactly once.
 */

export type ThemeName = 'midnight' | 'graphite' | 'paper'

/** What `--bg` is set to, per theme. The renderer's token maps read from here. */
export const THEME_BG: Record<ThemeName, string> = {
  midnight: '#12141c',
  graphite: '#131313',
  paper: '#f6f3ec'
}

export const DEFAULT_THEME: ThemeName = 'midnight'

/**
 * The `localStorage` key the choice is persisted under.
 *
 * Also spelled out as a literal by the pre-paint script in
 * `src/renderer/index.html` — that script runs before any module has loaded, so
 * it cannot import this. Change one, change the other.
 */
export const THEME_KEY = 'vivarium.theme'

/** Whether a value off `localStorage` (or IPC) is a theme this build knows. */
export function isThemeName(v: unknown): v is ThemeName {
  return v === 'midnight' || v === 'graphite' || v === 'paper'
}
