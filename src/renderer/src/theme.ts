// Global CSS ported verbatim from the design mockup (scratchpad/page.html):
// palette custom-props, keyframes, scrollbars. Injected once at startup.
import type { SessionType } from '@shared/types'

export const GLOBAL_CSS = `
  *{box-sizing:border-box}
  html,body,#root{margin:0;padding:0;height:100%;background:#0f141b}
  :root{
    --win:#0e131a;--bg:#0f141b;--sidebar:#12171f;--panel:#171d26;--field:#141a22;--field-2:#1c232d;
    --row-hover:#161c25;--sel:#1d2c3f;--border:#2a333f;--border-2:#1b222b;
    --text:#eef1f5;--text-2:#9aa6b6;--text-3:#6a7686;
    --accent:#5a769f;--accent-2:#6d88ad;--danger:#fa4d56;--overlay:rgba(2,4,7,.66);
    --terminal-bg:#0a0d12;--terminal-text:#c7cfda;
    --focus:#7f9dc4;--focus-soft:rgba(122,154,196,.20);
  }
  body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--text)}
  ::selection{background:rgba(69,137,255,.32)}
  /* Keyboard focus. Every field in this app sets outline:none inline and inline
     styles win, so the ring is drawn with box-shadow instead: a hairline in the
     accent hue plus a soft bloom, square like the controls it wraps. :focus-visible
     rather than :focus, so clicking never lights anything up — this is only for
     people driving the app from the keyboard, who until now had nothing at all. */
  :focus{outline:none}
  :focus-visible{outline:none;box-shadow:0 0 0 1px var(--focus),0 0 0 4px var(--focus-soft)}
  /* xterm parks a hidden textarea at the cursor and keeps it focused the whole
     time a terminal is active — a ring there would just follow the caret. */
  .xterm textarea:focus-visible{box-shadow:none}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:var(--border);border:2px solid transparent;background-clip:padding-box}
  ::-webkit-scrollbar-thumb:hover{background:var(--text-3)}
  input,button,textarea{font-family:inherit}
  @keyframes vthink{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
  @keyframes vpending{0%,100%{opacity:.35}50%{opacity:1}}
  @keyframes vover{from{opacity:0}to{opacity:1}}
  @keyframes vdlg{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @keyframes vpop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
`

// Per-session-type hues. Deliberately muted — three fully saturated colors
// (violet/cyan/green) next to this slate palette read as neon, and the old
// host-shell green was the exact same green as the "container running"
// indicator, so a session icon and a container state shared a color.
// Shape (see TypeIcon) is now the primary way to tell the types apart; color
// only reinforces it.
export const ACCENT: Record<string, string> = {
  agent: '#a78bdb',
  'container-shell': '#59a8a4',
  'host-shell': '#7d9ec9'
}

export interface SessionTypeMeta {
  type: SessionType
  /**
   * One word, and never a word another type also uses. The old labels were
   * "Terminal · container" / "Terminal · host": identical for the first nine
   * characters, which is exactly how far you read when picking from a list.
   */
  title: string
  /** '' for the agent; the two shells share a group heading in the picker */
  group: string
  /** what actually runs — the most concrete distinction there is */
  shell: string
  /** where it runs */
  where: string
  accent: string
}

/**
 * The three session kinds, in picker order: agent first (it's the point of the
 * app), then the shells with **host above container** — host is the one that
 * gets picked nearly every time.
 */
export const SESSION_TYPES: SessionTypeMeta[] = [
  {
    type: 'agent',
    title: 'Agent',
    group: '',
    shell: 'claude',
    where: 'in the container',
    accent: ACCENT.agent
  },
  {
    type: 'host-shell',
    title: 'Host',
    group: 'Terminal',
    shell: 'PowerShell',
    where: 'on Windows',
    accent: ACCENT['host-shell']
  },
  {
    type: 'container-shell',
    title: 'Container',
    group: 'Terminal',
    shell: 'bash',
    where: 'in the container',
    accent: ACCENT['container-shell']
  }
]

/**
 * Geometry of the new-session popover. Lives here rather than in the component
 * because openAddSession (store.ts) needs it to keep the panel on screen, and
 * the component importing the store already makes the other direction a cycle.
 */
export const ADD_SESSION_POPOVER = { width: 336, height: 380 }

export function typeMeta(type: string): SessionTypeMeta {
  return SESSION_TYPES.find((t) => t.type === type) ?? SESSION_TYPES[0]
}

/** Full name for prose and tooltips: 'Agent' / 'Host terminal' / 'Container terminal'. */
export function typeLabel(type: string): string {
  const m = typeMeta(type)
  return m.group ? `${m.title} ${m.group.toLowerCase()}` : m.title
}
