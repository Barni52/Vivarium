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
    /* Dark grey rather than the near-black it used to be (#0a0d12): the terminal
       now sits a step *above* --panel instead of a hole punched through it, which
       is what reads as modern next to this slate chrome. Must stay in sync with
       DARK_THEME.background in TerminalView — xterm paints its own canvas and
       cannot resolve a CSS var, and this var backs the gutter padding around it. */
    --terminal-bg:#1c2128;--terminal-text:#c7cfda;
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
  /* The chat log runs on its own near-black palette (CHAT in this file), and the
     app-wide thumb above is mixed for --bg. Scoped to the one scroller rather
     than themed globally: every other scrollbar in the app still sits on slate. */
  .vchat-scroll::-webkit-scrollbar-thumb{background:#232A32;border:3px solid #0B0D10;background-clip:padding-box}
  .vchat-scroll::-webkit-scrollbar-thumb:hover{background:#333C46}
`

/**
 * The one mono stack in the app — terminals, paths, container names, versions.
 * It used to be spelled out inline in ~20 components, which is why swapping the
 * face meant touching all of them; import this instead.
 *
 * JetBrains Mono rather than IBM Plex Mono: a taller x-height and a wider glyph
 * body make it hold up better at the 13px the terminal runs at, and its 0/O and
 * 1/l/I are drawn to be told apart, which matters for reading container ids and
 * hashes. Plex Mono stays as the first fallback — it is still bundled for the
 * sans family's sake, so an unresolved JetBrains lands on a known face rather
 * than on whatever Windows calls `monospace`.
 *
 * Note for the terminal: JetBrains Mono ships programming ligatures and xterm
 * does not run them (that needs the ligatures addon we don't load). They simply
 * don't fire — `!=` stays two glyphs — which is the behaviour we want anyway,
 * since a ligature is one glyph in two cells and the WebGL atlas is per-cell.
 */
export const MONO = "'JetBrains Mono', 'IBM Plex Mono', monospace"

// Per-session-type hues. Deliberately muted — three fully saturated colors
// (violet/cyan/green) next to this slate palette read as neon, and the old
// host-shell green was the exact same green as the "container running"
// indicator, so a session icon and a container state shared a color.
// Shape (see TypeIcon) is now the primary way to tell the types apart; color
// only reinforces it.
export const ACCENT: Record<string, string> = {
  agent: '#a78bdb',
  // A muted pink-violet that sits *beside* the agent violet without being it —
  // a chat session is an agent session, spoken to rather than typed at.
  chat: '#c08bb8',
  'container-shell': '#59a8a4',
  'host-shell': '#7d9ec9'
}

/**
 * The chat window's own palette and metrics — every value in it read off
 * `docs/redisign/Chat Terminal.html`, which is the design this window is built
 * to. It is deliberately **not** the app's slate palette: the chat is a reading
 * surface sitting inside a tool chrome, and it is darker and cooler than
 * everything around it on purpose, the way the terminal pane already is.
 *
 * One object rather than CSS custom properties, because these must not leak: the
 * sidebar, the title bar and the terminals keep `--bg`/`--panel`/`--text`, and a
 * chat colour reaching them would be a regression nobody notices until it ships.
 *
 * The two role hues are the whole point of the redesign and the answer to "the
 * distinction between user turn, tool call and ai response is very hard to tell
 * apart": warm coral for what *you* said, cool cyan for what Claude said, and
 * neither for the machinery, which lives in bordered mono cards instead.
 *
 * `live` is a green and that is allowed here where a mode chip's green would not
 * be: it marks the CLI process being up, which is the *same* fact the app's
 * running-indicator green already means. The ban is on a colour meaning two
 * different things, not on it meaning one thing twice.
 */
export const CHAT = {
  /** page, header, and the two panel fills */
  bg: '#0B0D10',
  header: '#0D1014',
  card: '#0F1418',
  composer: '#101419',
  /** hairlines, coarsest to finest */
  border: '#222A33',
  borderSoft: '#1B2027',
  borderCard: '#1E252D',
  borderComposer: '#212831',
  /** the band behind a `you` row — a lift, not a tint, so it works at any hue */
  band: 'rgba(255,255,255,.03)',
  /** type, brightest to dimmest */
  text: '#E4E7EB',
  prose: '#C3CBD4',
  dim: '#8A93A0',
  dim2: '#5C6470',
  dim3: '#4E5661',
  dim4: '#3F4753',
  /** you: coral. Also the list bullet and the context bar's fill. */
  you: '#E9825B',
  /** claude: cool cyan, and the colour of a link */
  claude: '#7FC3D6',
  /** the permission mode chip */
  mode: '#6E9FD4',
  /** the model chip's label */
  model: '#8FD0E0',
  /** the process is up */
  live: '#6FBF8B',
  /** plan / question — the "hold on" register, kept from the old CHIP */
  hold: '#C2A15E',
  danger: '#E06C6C',
  /** context fill, escalating — accent while there is room, then amber, then red */
  ctx: ['#E9825B', '#C2A15E', '#C97B7B']
}

/** The reading column. Everything in the log is centred in it, header to composer. */
export const CHAT_MEASURE = 880
/** Timestamp + role word. One number, so a row and a divider cannot drift apart. */
export const CHAT_GUTTER = 96

/** Which context tint a percentage earns. Colour appears when it means something. */
export function ctxColor(pct: number): string {
  // Percentages, never token counts: maxTokens came back as 1 000 000 on one
  // model, so a threshold expressed in tokens would never fire there.
  return pct >= 85 ? CHAT.ctx[2] : pct >= 60 ? CHAT.ctx[1] : CHAT.ctx[0]
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
 * The four session kinds, in picker order: the two agent kinds first (they are
 * the point of the app), then the shells with **host above container** — host is
 * the one that gets picked nearly every time.
 *
 * `chat` is a fourth type *alongside* `agent`, not a replacement — though it is
 * designed so it could swallow it later, so nothing here may assume the terminal
 * agent is gone.
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
    type: 'chat',
    title: 'Chat',
    group: '',
    shell: 'claude -p',
    where: 'in the container',
    accent: ACCENT.chat
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
export const ADD_SESSION_POPOVER = { width: 336, height: 434 }

export function typeMeta(type: string): SessionTypeMeta {
  return SESSION_TYPES.find((t) => t.type === type) ?? SESSION_TYPES[0]
}

/** Full name for prose and tooltips: 'Agent' / 'Host terminal' / 'Container terminal'. */
export function typeLabel(type: string): string {
  const m = typeMeta(type)
  return m.group ? `${m.title} ${m.group.toLowerCase()}` : m.title
}
