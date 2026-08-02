import React from 'react'
import type { ChatEntry, ChatToolStatus } from '@shared/types'
import { CHAT, CHAT_GUTTER as GUTTER, MONO } from '../../theme'
import { Elapsed } from '../Elapsed'
import { Md, Preview, clock } from './Markdown'

// The transcript, built to `docs/redisign/Chat Terminal.html`.
//
// **A two-column grid inside a reading column**, not a full-bleed gutter log. The
// left column is 96px of `hh:mm  role`, right-aligned; the right column is the
// message. Every row shares that boundary, which is what makes a long turn
// scannable — and the whole grid is centred in an 880px measure, because this is
// a window you *read* in and a paragraph that runs to a 2560px edge is not read,
// it is scanned.
//
// **The three families are told apart by treatment, not by the role word.** That
// was the bug: one grey mono line each, differing only in a word most of which
// are five characters long.
//
//   you     — a lifted band across the full row width, coral role word, bright
//             prose. It is what the eye finds when scrolling back.
//   claude  — no band, cool cyan role word, prose one step below white. The page.
//   the rest — bordered mono cards on `CHAT.card`. Tool calls, command output,
//             plans, clocks and stops all live in that one family, so a burst of
//             twelve of them reads as one block of machinery.

/** Row padding and the gutter→content gap, from the mockup. */
const ROW_PAD = '16px 18px'
const COL_GAP = 20

const mono: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.55
}

/**
 * One log row: the gutter, then the message.
 *
 * `band` is what a `you` row wears. It is a white lift rather than a tint of the
 * accent, so it reads the same whatever hue `CHAT.you` is set to and never
 * fights the coral role word sitting inside it.
 */
function Line({
  at,
  role,
  color,
  band = false,
  children
}: {
  at: number
  role: string
  color?: string
  /** the lifted background that marks a turn you started */
  band?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${GUTTER}px 1fr`,
        gap: COL_GAP,
        padding: ROW_PAD,
        background: band ? CHAT.band : undefined,
        // Only the banded row has an edge to round; every other row is a
        // transparent block on the page and a radius on it would draw nothing.
        borderRadius: band ? CHAT.radiusCard : undefined
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 9,
          justifyContent: 'flex-end',
          alignItems: 'baseline',
          paddingTop: 2,
          fontFamily: MONO,
          fontSize: 11,
          userSelect: 'none'
        }}
      >
        <span style={{ color: CHAT.dim4 }}>{clock(at)}</span>
        <span style={{ color: color ?? CHAT.dim2, fontWeight: 500 }}>{role}</span>
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}

/**
 * The machinery card: a bordered mono box on the panel fill.
 *
 * Everything that is not a person talking renders in one of these — the mockup
 * draws it once, for `model set to haiku-4 (…)`, and the argument generalises:
 * a tool call, a command's output and a turn clock are all the app reporting on
 * itself, and giving each its own chrome is how the log stopped being readable.
 */
function Card({
  children,
  tone,
  onClick,
  title
}: {
  children: React.ReactNode
  /** left marker colour; omitted for the ordinary case */
  tone?: string
  onClick?: () => void
  title?: string
}): React.ReactElement {
  return (
    <div
      onClick={onClick}
      title={title}
      style={{
        ...mono,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: CHAT.card,
        border: `1px solid ${tone ?? CHAT.borderCard}`,
        borderRadius: CHAT.radiusCard,
        color: CHAT.dim,
        cursor: onClick ? 'pointer' : undefined
      }}
    >
      {children}
    </div>
  )
}

export interface LogHandlers {
  /** expand a clipped tool body (main holds the full text) */
  onExpand: (entryId: string) => void
  /** expand a subagent row into its own sub-log */
  onExpandTask: (toolUseId: string, agentId: string | null) => void
  /** full bodies that have already been fetched */
  bodies: Record<string, string>
  subagents: Record<string, ChatEntry[]>
  /** the one Retry, offered by a crash / timeout row and by the read banner */
  onRetry: () => void
}

/**
 * Memoised, and that is not a micro-optimisation.
 *
 * A streaming turn upserts the row it is filling ~25 times a second, and every
 * one of those is a new `entries` array in the store. Without this, each of them
 * re-rendered *every* row in the log — including the settled markdown above,
 * which now costs a parse — and the answer arrived in visible steps. Rows are
 * value objects the store replaces rather than mutates, so identity is an exact
 * test for "did this row change", and `handlers` is memoised in ChatView for
 * this to have anything to hold on to.
 */
export const LogRow = React.memo(function LogRow({
  entry,
  handlers,
  depth = 0,
  streaming = false
}: {
  entry: ChatEntry
  handlers: LogHandlers
  depth?: number
  /** this is the row the running turn is writing into — reveal it smoothly */
  streaming?: boolean
}): React.ReactElement | null {
  switch (entry.kind) {
    case 'text':
      if (entry.role === 'you') {
        return (
          <Line at={entry.at} role="you" color={CHAT.you} band>
            {entry.md && (
              <div
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.68,
                  color: CHAT.text,
                  whiteSpace: 'pre-wrap'
                }}
              >
                {entry.md}
              </div>
            )}
            {entry.chips && entry.chips.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  flexWrap: 'wrap',
                  marginTop: entry.md ? 10 : 0,
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color: CHAT.dim3
                }}
              >
                {entry.chips.map((c, i) => (
                  <span key={`${c.name}-${i}`} title={c.detail}>
                    {c.kind === 'image' ? '▣' : c.kind === 'path' ? '≡' : '⌘'} {c.name}
                  </span>
                ))}
              </div>
            )}
          </Line>
        )
      }
      return <ClaudeText entry={entry} streaming={streaming} />

    case 'thinking':
      return <Thinking at={entry.at} md={entry.md} />

    case 'tool':
      return <ToolCard entry={entry} handlers={handlers} />

    case 'cmd':
      // A Skill's body (`/name`) is markdown the model wrote; a *local* command's
      // stdout has no title and is terminal output — `/context` draws an ASCII
      // meter, and reflowing that into a paragraph is how it used to render.
      return (
        <Line at={entry.at} role="cmd" color={CHAT.dim2}>
          {entry.title ? (
            <>
              <Card>{entry.title}</Card>
              <Md src={entry.md} />
            </>
          ) : (
            <Card>
              <span style={{ whiteSpace: 'pre-wrap' }}>{entry.md}</span>
            </Card>
          )}
          {entry.truncated && <div style={{ ...mono, color: CHAT.dim3, marginTop: 4 }}>…</div>}
        </Line>
      )

    case 'ask':
      // Once answered the chosen option keeps a tick while the rest go grey: the
      // options not taken are the record of what the decision was between.
      //
      // Three things the chips alone leave out, and all three are decisions the
      // record has to keep: whether the question took one answer or several
      // (`choose any` vs a single tick reads as a *failed* multi-select
      // otherwise), an **Other** answer, which is a value matching no option and
      // so ticks nothing at all, and the notes typed against it. The chosen
      // option's **preview** is here too, because it is what the model was
      // shown — it travels back in `annotations[question].preview`.
      return (
        <Line at={entry.at} role="ask" color={CHAT.hold}>
          {entry.questions.map((q, qi) => {
            const answer = entry.answers.find((a) => a.question === q.question)
            const values = answer?.values ?? []
            const typed = values.filter((v) => !q.options.some((o) => o.label === v))
            const preview = q.options.find((o) => values.includes(o.label))?.preview
            return (
              <div key={qi} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 9,
                    marginBottom: 8,
                    flexWrap: 'wrap'
                  }}
                >
                  {q.header && (
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        letterSpacing: '.04em',
                        textTransform: 'uppercase',
                        padding: '2px 6px',
                        border: `1px solid ${CHAT.border}`,
                        borderRadius: CHAT.radius,
                        color: CHAT.hold,
                        flex: 'none'
                      }}
                    >
                      {q.header}
                    </span>
                  )}
                  <span style={{ fontSize: 14, lineHeight: 1.6, color: CHAT.prose }}>
                    {q.question}
                  </span>
                  <span style={{ ...mono, fontSize: 10.5, color: CHAT.dim4 }}>
                    {q.multiSelect ? 'choose any' : 'choose one'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {q.options.map((o) => {
                    const picked = values.includes(o.label)
                    return (
                      <span
                        key={o.label}
                        title={o.description}
                        style={{
                          fontFamily: MONO,
                          fontSize: 11.5,
                          padding: '5px 11px',
                          border: `1px solid ${picked ? CHAT.hold : CHAT.border}`,
                          borderRadius: CHAT.radius,
                          color: picked ? CHAT.text : CHAT.dim3,
                          background: picked ? CHAT.card : 'transparent'
                        }}
                      >
                        {picked ? '✓ ' : ''}
                        {o.label}
                      </span>
                    )
                  })}
                  {typed.map((t) => (
                    <span
                      key={t}
                      title="answered in the user's own words"
                      style={{
                        fontFamily: MONO,
                        fontSize: 11.5,
                        padding: '5px 11px',
                        border: `1px dashed ${CHAT.hold}`,
                        borderRadius: CHAT.radius,
                        color: CHAT.text,
                        background: CHAT.card
                      }}
                    >
                      ✓ {t}
                    </span>
                  ))}
                </div>
                {answer?.notes && (
                  <div style={{ ...mono, color: CHAT.dim3, marginTop: 6 }}>
                    notes: {answer.notes}
                  </div>
                )}
                {preview && (
                  // Capped here, unlike in the pinned card: this is history, and
                  // a 28-line mockup would otherwise own the log every time you
                  // scrolled past the decision it belongs to.
                  <div
                    style={{
                      marginTop: 8,
                      maxHeight: 300,
                      overflow: 'auto',
                      padding: '6px 12px',
                      background: CHAT.card,
                      border: `1px solid ${CHAT.borderCard}`,
                      borderRadius: CHAT.radiusCard
                    }}
                  >
                    <Preview src={preview} />
                  </div>
                )}
              </div>
            )
          })}
        </Line>
      )

    case 'plan':
      // The body renders here, in its place in time, so the transcript stays a
      // complete record; the *buttons* are pinned above the composer, so a
      // decision cannot scroll away behind twenty tool calls.
      return (
        <Line at={entry.at} role="plan" color={CHAT.hold}>
          <div
            style={{
              background: CHAT.card,
              border: `1px solid ${CHAT.borderCard}`,
              borderLeft: `2px solid ${CHAT.hold}`,
              borderRadius: CHAT.radiusCard,
              padding: '4px 15px 12px',
              opacity: entry.state === 'cancelled' ? 0.7 : 1
            }}
          >
            <Md src={entry.md} />
            {entry.state !== 'pending' && (
              <div style={{ ...mono, color: CHAT.dim3, marginTop: 6 }}>{entry.state}</div>
            )}
          </div>
        </Line>
      )

    case 'task':
      return <TaskRow entry={entry} handlers={handlers} depth={depth} />

    case 'todo':
      // Always one line — it changed nothing on disk; the *fold* (current state)
      // is the strip above the composer.
      return (
        <Line at={entry.at} role="todo" color={CHAT.dim2}>
          <div style={{ ...mono, color: CHAT.dim3, paddingTop: 3 }}>{entry.text}</div>
        </Line>
      )

    case 'stop':
      // Muted for an interrupt, red for a crash. Colour in this chrome means
      // *attend to this*; an interrupt is something the user just did, so it
      // earns a role word and nothing more.
      return (
        <Line
          at={entry.at}
          role="stop"
          color={entry.tone === 'alert' ? CHAT.danger : CHAT.dim2}
        >
          <Card tone={entry.tone === 'alert' ? CHAT.danger : undefined}>
            <span style={{ color: entry.tone === 'alert' ? CHAT.danger : CHAT.dim }}>
              {entry.text}
            </span>
            {entry.retry && (
              // Never automatic: a respawn costs a process and a 14.6 MB-class
              // transcript read, and a crash loop that retried itself would be
              // invisible. The 60s-timeout row especially — a genuinely wedged
              // CLI would otherwise be respawned every minute all day.
              <button
                onClick={handlers.onRetry}
                style={{
                  ...mono,
                  marginLeft: 'auto',
                  border: `1px solid ${CHAT.border}`,
                  background: 'transparent',
                  color: CHAT.dim2,
                  padding: '2px 10px',
                  cursor: 'pointer'
                }}
              >
                retry
              </button>
            )}
          </Card>
        </Line>
      )

    case 'divider':
      return (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `${GUTTER}px 1fr`,
            gap: COL_GAP,
            padding: '10px 18px'
          }}
        >
          <span />
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ ...mono, color: CHAT.dim3, flex: 'none' }}>{entry.text}</span>
            <span style={{ flex: 1, height: 1, background: CHAT.borderSoft }} />
          </span>
        </div>
      )

    case 'turn':
      // The turn clock, in the log where the eye already is — live while the turn
      // runs, frozen in place at `result`. Not a header chip: the header is three
      // readings and no fourth, and a separate activity lane was the thing an
      // earlier variant lost on.
      return (
        <Line at={entry.at} role="run" color={CHAT.dim2}>
          <Card>
            {entry.durationMs === undefined ? (
              <>
                <Dots />
                <span>working ·</span>
                <Elapsed since={entry.startedAt} />
                {/* Discoverability for interrupt, on screen exactly when it is
                    usable and nowhere else. */}
                <span style={{ color: CHAT.dim3 }}>· esc interrupts</span>
              </>
            ) : (
              <span>
                done · <Elapsed since={0} until={entry.durationMs} />
              </span>
            )}
          </Card>
        </Line>
      )
  }
})

/** How often the reveal advances. 30 fps — text has no motion to alias. */
const REVEAL_TICK = 33
/**
 * How long the reveal takes to catch up with whatever is outstanding.
 *
 * Measured on the host against `claude -p --include-partial-messages`: prose
 * arrives in **~68-character jumps about every 460 ms**, nine paint steps for a
 * 554-character paragraph. That cadence is Claude Code's, not this app's — the
 * frames really do land that far apart — and it is the whole of "streaming feels
 * choppy": the log lurches a line and a half at a time and then sits still.
 * Coalescing on main cannot help, because the source is already coarser than any
 * window worth batching over.
 *
 * So the buffer is drained at a steady rate instead. 420 ms is deliberately just
 * under the observed arrival interval: each chunk finishes revealing a moment
 * before the next one lands, which is continuous motion rather than a typewriter
 * that visibly falls behind. It is a *rate*, not a delay — a big chunk drains
 * proportionally faster, so the text on screen can never lag the model by more
 * than one interval however fast the model goes.
 */
const REVEAL_CATCHUP = 420

/**
 * The one row a running turn is writing into, revealed at a steady rate.
 *
 * It starts from whatever the row already held when it mounted and smooths only
 * what arrives *after* — so a chat reopened mid-turn, a settle, and every row of
 * history paint instantly, and nothing ever re-types itself.
 */
function ClaudeText({
  entry,
  streaming
}: {
  entry: Extract<ChatEntry, { kind: 'text' }>
  streaming: boolean
}): React.ReactElement {
  const target = entry.md
  const [shown, setShown] = React.useState(target.length)

  React.useEffect(() => {
    // The turn ended (or this was never the live row): everything is on screen.
    // A typewriter still running after the answer is finished is worse than no
    // smoothing at all.
    //
    // `shown` is caught up rather than just left alone, because it outlives the
    // turn. The reveal is a *rate*, so it is always a little behind when the
    // answer lands — freezing it there left the row holding a count from the
    // middle of a paragraph it has since painted whole, and anything that
    // flagged the row `streaming` again read that count as "start from here" and
    // re-typed the rest. Nothing may re-type itself; this is what makes that
    // true after the first render as well as at it.
    if (!streaming) {
      if (shown < target.length) setShown(target.length)
      return
    }
    if (shown >= target.length) return
    const t = setInterval(() => {
      setShown((n) => {
        if (n >= target.length) return target.length
        const behind = target.length - n
        return Math.min(target.length, n + Math.max(1, Math.ceil((behind * REVEAL_TICK) / REVEAL_CATCHUP)))
      })
    }, REVEAL_TICK)
    return () => clearInterval(t)
  }, [streaming, target, shown])

  const md = streaming ? target.slice(0, Math.min(shown, target.length)) : target
  return (
    <Line at={entry.at} role="claude" color={CHAT.claude}>
      <Md src={md} />
    </Line>
  )
}

/** Three-dot working indicator, reusing the app's existing vthink keyframes. */
export function Dots({ color = CHAT.you }: { color?: string }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', flex: 'none' }}>
      {[0, 1, 2].map((n) => (
        <span
          key={n}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: color,
            animation: `vthink 1.1s ${n * 0.16}s infinite ease-in-out`
          }}
        />
      ))}
    </span>
  )
}

/**
 * Thinking sits on the `claude` row in the mockup — one italic line with a
 * `show` on the right, above the prose it led to. It keeps its own row here
 * because main emits it as its own entry, but it wears the same clothes.
 */
function Thinking({ at, md }: { at: number; md: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const first = md.trim().split('\n')[0] ?? ''
  return (
    <Line at={at} role="claude" color={CHAT.claude}>
      <div
        onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 9, cursor: 'pointer', userSelect: 'none' }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            fontStyle: 'italic',
            // A token, not a hex: this was the one colour in the log mixed by
            // eye against the old page, so it was also the only one that did
            // not move when the page did.
            color: CHAT.dim3,
            lineHeight: 1.6,
            whiteSpace: open ? 'pre-wrap' : 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {open ? md : first}
        </div>
        <div style={{ flex: 'none', fontFamily: MONO, fontSize: 10.5, color: CHAT.dim3 }}>
          {open ? 'hide' : 'show'}
        </div>
      </div>
    </Line>
  )
}

function statusColor(status: ChatToolStatus): string {
  if (status === 'error') return CHAT.danger
  return CHAT.dim2
}

/**
 * How tall a body may be and still open itself.
 *
 * The rule below is "show me what changed, don't bury the conversation", and
 * past about fifteen lines a card stops doing the first and starts doing the
 * second: one 300-line diff pushes the answer that explains it off the top of
 * the window, and scrolling back through a turn becomes scrolling through its
 * machinery. Fifteen is roughly a card that still reads as an inset in a page
 * rather than as a page of its own.
 */
const AUTO_OPEN_LINES = 15

/** Lines in a body, without splitting the whole string to count them. */
function lineCount(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * **Open by default and truncated — inverted from the obvious default.** An edit
 * shows its diff and a command shows the tail of its output; a read and a search
 * collapse to their card. A read changed nothing; a diff is what you scrolled
 * back for. Collapse-everything was rejected for making the common case a click.
 *
 * The exception is size (AUTO_OPEN_LINES), and it is the same argument rather
 * than a retreat from it: a body only shows what changed while it is small
 * enough to be read in place.
 */
function ToolCard({
  entry,
  handlers
}: {
  entry: Extract<ChatEntry, { kind: 'tool' }>
  handlers: LogHandlers
}): React.ReactElement {
  const full = handlers.bodies[entry.id]
  const text = full ?? entry.body.text
  const expandable = entry.body.kind !== 'none' && !!entry.body.text
  const lines = lineCount(entry.body.text)
  const quiet =
    entry.role === 'read' ||
    entry.body.kind === 'none' ||
    // A cancelled card collapses: its synthetic result carries only the refusal
    // sentence, so an open card would be a card showing nothing.
    entry.status === 'cancelled' ||
    // `truncated` means main already clipped it, so it is longer than whatever
    // this counts — a body that long is never opened for you.
    entry.body.truncated ||
    lines > AUTO_OPEN_LINES

  /**
   * `null` until you touch it, and that is what makes the size rule work at all.
   *
   * A tool card mounts while the call is still *running*, with no body and no
   * length to judge — `useState(!quiet)` read that empty body once and kept the
   * answer, so every card that finished after it appeared opened itself however
   * long the output turned out to be. Deriving the default instead lets the
   * result decide when it lands, while a click still wins for good: the entry is
   * replaced wholesale at the turn's settle, and a flag on the entry would have
   * been thrown away with it.
   */
  const [choice, setChoice] = React.useState<boolean | null>(null)
  const open = choice ?? !quiet

  const toggle = (): void => {
    if (!expandable) return
    if (!open && entry.body.truncated) handlers.onExpand(entry.id)
    setChoice(!open)
  }

  return (
    <Line at={entry.at} role={entry.role} color={CHAT.dim2}>
      <Card onClick={expandable ? toggle : undefined}>
        <span
          style={{
            color: CHAT.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {entry.title}
        </span>
        {entry.status === 'running' ? (
          <>
            <Dots />
            {/* A tool running past ~2s shows a number, so a fast Read never
                flickers one. */}
            <SlowClock since={entry.at} />
          </>
        ) : (
          <span style={{ color: statusColor(entry.status), flex: 'none' }}>{entry.result}</span>
        )}
        {expandable && (
          <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 10.5, color: CHAT.dim3 }}>
            {/* A card that closed itself says how much it is holding, or the
                size rule reads as the app having lost the output. `+` where main
                clipped the body: this counts what arrived, not what exists. */}
            {open
              ? 'hide'
              : lines > AUTO_OPEN_LINES
                ? `show ${lines}${entry.body.truncated ? '+' : ''} lines`
                : 'show'}
          </span>
        )}
      </Card>

      {open && entry.body.kind === 'diff' && (
        <div
          style={{
            ...mono,
            marginTop: 6,
            border: `1px solid ${CHAT.borderCard}`,
            background: CHAT.card,
            borderRadius: CHAT.radiusCard,
            // The rounded corner has to clip the tinted rows, or a `+` line at
            // the top of a diff paints its green back into the square corner.
            overflow: 'hidden',
            overflowX: 'auto'
          }}
        >
          {text.split('\n').map((l, i) => (
            <div
              key={i}
              style={{
                whiteSpace: 'pre',
                background: l.startsWith('+')
                  ? 'rgba(111,191,139,.10)'
                  : l.startsWith('-')
                    ? 'rgba(224,108,108,.10)'
                    : 'transparent',
                color: l.startsWith('+') || l.startsWith('-') ? CHAT.prose : CHAT.dim3,
                padding: '0 10px'
              }}
            >
              {l || ' '}
            </div>
          ))}
          {entry.body.truncated && !full && (
            <div style={{ padding: '2px 10px', color: CHAT.dim3 }}>…</div>
          )}
        </div>
      )}

      {open && entry.body.kind === 'text' && (
        <div
          style={{
            ...mono,
            marginTop: 6,
            padding: '9px 12px',
            border: `1px solid ${CHAT.borderCard}`,
            background: CHAT.card,
            borderRadius: CHAT.radiusCard,
            color: CHAT.dim,
            whiteSpace: 'pre-wrap',
            overflowX: 'auto'
          }}
        >
          {text}
        </div>
      )}
    </Line>
  )
}

/** A duration that appears only once the call is genuinely slow. */
function SlowClock({ since }: { since: number }): React.ReactElement | null {
  const [show, setShow] = React.useState(Date.now() - since > 2000)
  React.useEffect(() => {
    if (show) return
    const t = setTimeout(() => setShow(true), 2000)
    return () => clearTimeout(t)
  }, [show])
  if (!show) return null
  return <Elapsed since={since} style={{ ...mono, color: CHAT.dim3 }} />
}

/**
 * One `task` row that expands into its own sub-log.
 *
 * The filesystem hands us exactly this shape, which is the reason to trust it:
 * the parent transcript already *is* the collapsed view, and the sibling file
 * already *is* the expansion. The sub-log nests — a subagent's own subagent is
 * another task row that expands the same way, with no depth cap.
 */
function TaskRow({
  entry,
  handlers,
  depth
}: {
  entry: Extract<ChatEntry, { kind: 'task' }>
  handlers: LogHandlers
  depth: number
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const sub = handlers.subagents[entry.toolUseId] ?? []

  const toggle = (): void => {
    if (!open) handlers.onExpandTask(entry.toolUseId, entry.agentId)
    setOpen(!open)
  }

  const stats = [
    entry.status,
    entry.durationMs !== null ? `${Math.round(entry.durationMs / 1000)}s` : null,
    entry.tools !== null ? `${entry.tools} tools` : null,
    entry.tokens !== null ? `${Math.round(entry.tokens / 100) / 10}k tok` : null
  ].filter(Boolean)

  return (
    <>
      <Line at={entry.at} role="task" color={CHAT.dim2}>
        <Card onClick={toggle}>
          <span style={{ color: CHAT.text, flex: 'none' }}>{entry.agentType}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {entry.description}
          </span>
          {entry.running ? (
            <>
              <Dots />
              <Elapsed since={entry.at} style={{ flex: 'none' }} />
            </>
          ) : (
            <span style={{ flex: 'none', color: CHAT.dim2 }}>{stats.join(' · ')}</span>
          )}
          <span style={{ flex: 'none', fontSize: 10.5, color: CHAT.dim3 }}>
            {open ? 'hide' : `show${sub.length ? ` ${sub.length}` : ''}`}
          </span>
        </Card>
      </Line>
      {open && (
        <div style={{ borderLeft: `1px solid ${CHAT.borderSoft}`, marginLeft: GUTTER + 18 }}>
          {sub.map((e) => (
            <LogRow key={e.id} entry={e} handlers={handlers} depth={depth + 1} />
          ))}
          {sub.length === 0 && (
            <div style={{ ...mono, color: CHAT.dim3, padding: '8px 18px' }}>no steps recorded</div>
          )}
        </div>
      )}
    </>
  )
}
