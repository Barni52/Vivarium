// Global CSS ported verbatim from the design mockup (scratchpad/page.html):
// palette custom-props, keyframes, scrollbars. Injected once at startup.
import type { SessionType } from '@shared/types'

// The app's own chrome. `GLOBAL_CSS` — what actually gets injected — is this
// plus the handful of chat rules at the bottom of the file, which are down there
// so they can interpolate `CHAT` rather than restate its hex codes in a string
// that would then drift from it silently.
const APP_CSS = `
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

/**
 * The app's text face, which `body` already sets — so this exists for exactly
 * one job: getting *back* to it inside a subtree that has declared mono.
 *
 * The chat window is mono from its root down, and the one thing in it that is
 * not a transcript is the question dialog: a form with checkboxes, radios and
 * prose descriptions, which in mono read as terminal output that happens to be
 * clickable.
 */
export const SANS = "'IBM Plex Sans', system-ui, sans-serif"

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
 * The chat window's own palette and metrics. It is deliberately **not** the
 * app's slate palette: the chat is a reading surface sitting inside a tool
 * chrome, and it keeps its own temperature the way the terminal pane already
 * does.
 *
 * It used to be near-black, read off `docs/redisign/Chat Terminal.html`. It is
 * now **the agent tab's greys**: the page is `--terminal-bg`, the chrome is
 * `--panel`, the hairlines are `--border`, and the prose is `--terminal-text`.
 * Switching between an agent and a chat in the same project should not feel like
 * switching applications — the two are the same tool looking at the same work,
 * and the near-black page made the chat look like a different one.
 *
 * That leaves it a *copy* of those four values rather than a reference to them,
 * which is deliberate and is the same argument as before: these must not leak.
 * The sidebar, the title bar and the terminals keep `--bg`/`--panel`/`--text` as
 * custom properties; the chat holds plain strings, so nothing here can reach
 * them and nothing there can drag the chat with it. What is copied is the
 * *reading* — "the page is the terminal's grey" — and if that grey ever moves,
 * this is the second place to move it.
 *
 * Two tokens exist because a page this dark has no spare room underneath it:
 * `well` is the recess inside a panel (a chip's fill, the meter's track), and
 * `onAccent` is the ink on a filled accent. Both used to be `bg` itself, which
 * only worked while `bg` happened to be the darkest thing on screen.
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
  /** the page — `--terminal-bg`, the grey an agent session runs on */
  bg: '#1C2128',
  /** the chrome: header and composer sit one step back, on `--panel` */
  header: '#171D26',
  composer: '#171D26',
  /** machinery cards — the chrome's fill, so a tool card reads as chrome in the page */
  card: '#171D26',
  /** a recess *inside* a panel: a chip's fill, the meter's track. `--field`. */
  well: '#141A22',
  /** ink on a filled accent — the send button, a ticked option. `--bg`. */
  onAccent: '#0F141B',
  /** hairlines, coarsest to finest — `--border` down towards `--border-2` */
  border: '#2A333F',
  borderSoft: '#232B35',
  borderCard: '#262E39',
  borderComposer: '#242C36',
  /** the band behind a `you` row — a lift, not a tint, so it works at any hue */
  band: 'rgba(255,255,255,.04)',
  /** a row under the pointer, or a toggle that is on */
  hover: 'rgba(255,255,255,.05)',
  /**
   * Corners. `radius` is for controls (buttons, chips, the mode toggle) and
   * `radiusCard` for the panels they sit in — one step larger, because a card's
   * corner reads tighter than a button's at the same number.
   */
  radius: 4,
  radiusCard: 6,
  /**
   * Type, brightest to dimmest — `--text`, then the terminal's own
   * `--terminal-text` for prose, then `--text-2`/`--text-3` and one step below.
   * A chat paragraph and an agent's output are the same words about the same
   * work, so they are set in the same grey.
   */
  text: '#EEF1F5',
  prose: '#C7CFDA',
  dim: '#9AA6B6',
  dim2: '#7B8695',
  dim3: '#6A7686',
  dim4: '#5A6473',
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

/**
 * Syntax highlighting, for fenced code blocks and the diff a tool card holds.
 *
 * Eight hues and no more. The muting rule `ACCENT` documents applies here twice
 * over: a code block sits on `CHAT.card`, which is *lighter* than the page, so a
 * saturated token has even less slate to be quiet against — and unlike a session
 * icon there are seven of them at once, in a grid, at 11.5px. Every colour below
 * is a step or two off the pure hue for that reason.
 *
 * Two of them are `CHAT` greys reused deliberately: a comment is the dimmest
 * thing in the window and `dim4` is what "dimmest" already means here, and
 * punctuation is structure rather than content, which is `dim2`'s job in the
 * gutter too. Plain code is not in this object at all — it inherits `CHAT.prose`
 * from the `<pre>`, so a block in a language we do not have renders exactly as it
 * did before highlighting existed.
 *
 * Three near-misses are on purpose, and all three are the one-colour-one-meaning
 * rule being obeyed rather than ignored:
 *   - `string` is a sage green and **not** `CHAT.live` (#6FBF8B), which means "the
 *     CLI process is up" and appears a few pixels away in the header.
 *   - `fn` is a steel blue and **not** `CHAT.claude` (#7FC3D6), which means "Claude
 *     said this" and is also the colour of a link in the paragraph above the block.
 *   - `del` is a soft red and **not** `CHAT.danger` (#E06C6C), which is reserved for
 *     something having gone wrong; a removed line is a fact, not a failure.
 */
export const CODE = {
  /** comments, and anything else the language treats as ignorable */
  comment: '#5A6473',
  /** braces, semicolons, operators — structure, not content */
  punct: '#7B8695',
  /** `if`, `class`, `public`, `import` */
  keyword: '#B98BC9',
  /** strings, chars, template literals, regex, attribute values */
  string: '#9CC49A',
  /** numbers, and the constants that read like them: booleans, `null`, enums */
  number: '#D6A06B',
  /** a name in call or definition position */
  fn: '#82B7DE',
  /** class names, tags, attribute names, Java annotations, JSON keys */
  type: '#E0C58A',
  /** a ```diff fence's own signs. The tool card's diff tints the row instead. */
  ins: '#9CC49A',
  del: '#D08A8A'
}

/**
 * Everything injected at startup: the app's chrome, then the chat's.
 *
 * The chat rules live here rather than in `APP_CSS` for one reason — they are
 * written in terms of `CHAT`, and a string above the palette could only restate
 * its hex codes. Every one of them is **scoped to `.vchat`**, which is the class
 * on the chat's root, so none of it can reach the sidebar, the title bar or the
 * terminals; that scoping is the same guarantee the palette gets from being a
 * plain object instead of custom properties.
 *
 * The radius rule is the reason this is worth doing at all: it rounds every
 * control in the window, including the ones nobody has written yet, where a
 * `borderRadius` threaded through ~25 inline styles rounds only today's.
 */
export const GLOBAL_CSS = `${APP_CSS}
  .vchat button,.vchat input,.vchat textarea{border-radius:${CHAT.radius}px}
  /* Hover and press, once, for every control in the window — the same argument
     the radius rule makes, and the reason both live here: they reach the
     controls nobody has written yet.

     It has to be a **filter** rather than a background. Every control in this
     window is styled *inline* (the palette is a plain object precisely so it
     cannot leak), and an inline background beats any rule this sheet could
     write — the hover would silently do nothing on exactly the controls that
     need it, which is the same trap the focus ring documents. Brightness lifts
     a filled button's fill, a card's panel and a transparent chip's border and
     label alike, so one declaration covers all three shapes.

     The data-click attribute is for what is clickable without being a button:
     a tool card and the thinking row, which are divs because they wrap block
     content a button may not contain. */
  .vchat button:not(:disabled),.vchat [data-click]{transition:filter .12s,background-color .12s,border-color .12s,color .12s}
  .vchat button:not(:disabled):hover,.vchat [data-click]:hover{filter:brightness(1.32)}
  .vchat button:not(:disabled):active,.vchat [data-click]:active{filter:brightness(.9)}
  /* The chat runs its own palette, and the app-wide thumb is mixed for --bg. */
  .vchat-scroll::-webkit-scrollbar-thumb{background:${CHAT.border};border:3px solid ${CHAT.bg};background-clip:padding-box}
  .vchat-scroll::-webkit-scrollbar-thumb:hover{background:${CHAT.dim4}}
`

/**
 * The chat's type scale.
 *
 * One object because "make the chat a bit smaller" is one request, and it used
 * to be thirty inline numbers across three files. It is **not** the zoom: zoom
 * is what a reader reaches for at their own desk and it multiplies everything
 * here. This is the size the window is drawn at before they touch it.
 *
 * Everything came down about a point: at 14.5/1.68 the log read as a document
 * being typeset rather than a conversation being followed, and the leading was
 * the louder half of that — a paragraph is three or four lines here, not thirty,
 * so it does not need a book's air between them.
 */
export const CHAT_TEXT = {
  /** a message body, and the `Md` size every heading and table derives from */
  prose: 13.5,
  /** leading inside a paragraph and between the items of a list */
  proseLine: 1.6,
  /** machinery: tool cards, clocks, command output, the composer's status line */
  mono: 11,
  /** the gutter's `hh:mm role`, chips, and the `show 40 lines` hints */
  gutter: 10.5,
  /** fenced code and an `AskUserQuestion` preview — a grid, which holds its own */
  code: 11.5
}

/**
 * The chat's left and right margin — the *only* thing between the log and the
 * window edge.
 *
 * There used to be an 880px reading measure here and the column was centred in
 * it. The argument for it (a paragraph that runs to a 2560px edge is scanned,
 * not read) is a real one, and it lost to what it actually looked like: on a
 * maximised window the conversation was a narrow ribbon with a wide band of dead
 * background down each side, and the band on the left read as wider still
 * because the gutter was inside the column and the prose started another 100px
 * in. The window is the measure now — the user picks it by sizing the window,
 * which is the control they already have and the one they were reaching for. The
 * gutter column went the same way and for the same reason (see `ChatLog`): its
 * `CHAT_GUTTER` of 84 was the last horizontal number in the log that the content
 * did not get to use, so `CHAT_EDGE` is now the whole of the left margin, on
 * every line of every message rather than only on the ones a role word did not
 * happen to sit beside.
 */
export const CHAT_EDGE = 14

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
