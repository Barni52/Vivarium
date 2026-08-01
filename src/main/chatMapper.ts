import type {
  ChatChip,
  ChatEntry,
  ChatQuestion,
  ChatQuestionOption,
  ChatRole,
  ChatTodo,
  ChatToolBody,
  ChatToolStatus
} from '@shared/types'

// The chat log's one mapper: Claude Code's own JSON → the rows the window draws.
//
// It is deliberately ONE function for two sources. While a turn runs, rows are
// painted from the stream (provisional); at the turn's `result` main re-reads the
// bytes appended to the transcript, maps them through here and *replaces* that
// turn's rows with the transcript-derived ones. That is what makes history the
// app never streamed look identical to history it did — structurally, rather than
// by keeping two mappers in step. Both envelopes carry the same Anthropic
// content-block array under `message`, with the same `message.id` and
// `tool_use.id`, so only the envelope differs and entry ids line up across the
// settle.
//
// **A whitelist, not a blacklist.** `attachment` alone was 2 313 lines in a
// 20-transcript sample, of which 1 877 were `total_tokens_reminder` — injected
// context, not conversation. New line types keep appearing as Claude Code ships:
// a whitelist degrades by missing something, a blacklist by rendering garbage.
//
// **`isSidechain` is never filtered on here, and that corrects the spec.** The
// rule inherited from #7 was "drop isSidechain in the main mapper", read off 20
// transcripts written by the *TUI*, where every line carries `isSidechain: false`.
// A transcript written by `claude -p` — which is every chat session — marks
// **every line true**, main conversation included (verified against 2.1.211:
// 0 false / all true in a -p file, the exact inverse of a TUI file). Filtering on
// it would blank the entire log for exactly the sessions this feature creates.
// It is also unnecessary: subagent work is not written into the parent file at
// all (it lives in the sibling subagents/ directory), so there is nothing here
// for the flag to protect against.

/** Injected context that must never reach a `you` row as though it were typed. */
const STRIP_TAGS = /<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>\s*/g

/**
 * Attached file paths ride in a delimited trailer rather than an interpolated
 * sentence, because the transcript is the history model: this parses back into
 * chips on reopen, where a path you typed by hand and a path you attached would
 * otherwise be indistinguishable. Images and PDFs need no marker — they are real
 * content blocks and replay as themselves.
 */
export const ATTACH_OPEN = '<vivarium-attached>'
export const ATTACH_CLOSE = '</vivarium-attached>'
const ATTACH_RE = /<vivarium-attached>\n([\s\S]*?)\n<\/vivarium-attached>/g

/** The synthetic user message Claude Code writes where a turn was cut. */
const INTERRUPT_MARKER = '[Request interrupted by user]'

/** A typed slash command records as a plain user row wrapped in these. */
const COMMAND_RE = /<command-name>([^<]*)<\/command-name>(?:<command-args>([^<]*)<\/command-args>)?/

const LOCAL_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/

// Truncation budgets. Main keeps the full body and hands the renderer these —
// tool output is the entire weight of a transcript and variant D keeps most of it
// collapsed anyway, so shipping it all would make a 10 MB conversation a 10 MB
// structured clone *and* a 10 MB resident store.
const BASH_TAIL_LINES = 40
const DIFF_MAX_LINES = 200

/** Tool name → gutter role. Everything unrecognised is a `run`. */
function roleForTool(name: string): ChatRole {
  if (/^(Read|NotebookRead)$/.test(name)) return 'read'
  if (/^(Grep|Glob|WebSearch|WebFetch|ToolSearch)$/.test(name)) return 'read'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit'
  if (/^(Bash|BashOutput|KillShell|PowerShell)$/.test(name)) return 'bash'
  if (name === 'Skill') return 'cmd'
  if (/^(Task|Agent)$/.test(name)) return 'task'
  if (/^Task(Create|Update)$/.test(name)) return 'todo'
  if (name === 'AskUserQuestion') return 'ask'
  if (name === 'ExitPlanMode') return 'plan'
  return 'run'
}

type Json = Record<string, unknown>

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Flatten a tool_result's content (string, or a block array) to plain text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((b) => {
      const o = obj(b)
      if (!o) return ''
      if (o.type === 'text') return str(o.text)
      if (o.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function firstLine(s: string): string {
  const t = s.trim().split('\n')[0] ?? ''
  return t.length > 160 ? `${t.slice(0, 157)}…` : t
}

function compact(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Human title for a tool card — the thing you scan for when scrolling back. */
function toolTitle(name: string, input: Json): string {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const off = num(input.offset)
      const lim = num(input.limit)
      return off !== null ? `${path}:${off}${lim !== null ? `-${off + lim}` : ''}` : path
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path
    case 'Bash':
      return compact(str(input.command), 160)
    case 'Grep':
      return `${str(input.pattern)}${input.path ? ` in ${str(input.path)}` : ''}`
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Skill':
      return `/${str(input.skill) || str(input.name)}`
    case 'TaskCreate':
      return str(input.subject)
    case 'TaskUpdate':
      return `${str(input.taskId)} · ${str(input.status)}`
    default: {
      const summary = compact(
        Object.entries(input)
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' '),
        100
      )
      return summary ? `${name} ${summary}` : name
    }
  }
}

/** Body + one-line outcome for a completed tool call. */
function toolBody(
  name: string,
  input: Json,
  result: Json | null,
  text: string
): { body: ChatToolBody; result: string } {
  // An edit shows its diff and a command shows the tail of its output; a read
  // and a search collapse to their gutter line. A read changed nothing; a diff is
  // what you scrolled back for.
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) {
    const lines: string[] = []
    let plus = 0
    let minus = 0
    for (const hunk of arr(result?.structuredPatch)) {
      const h = obj(hunk)
      if (!h) continue
      for (const raw of arr(h.lines)) {
        const l = str(raw)
        if (l.startsWith('+')) plus++
        else if (l.startsWith('-')) minus++
        lines.push(l)
      }
      lines.push('')
    }
    if (lines.length === 0) {
      // No structured patch (a Write, or an older CLI): show what was written,
      // marked as added so the diff renderer has something honest to colour.
      const content = str(input.content) || str(input.new_string)
      for (const l of content.split('\n')) {
        lines.push(`+${l}`)
        plus++
      }
      for (const l of str(input.old_string).split('\n')) {
        if (!l) continue
        lines.push(`-${l}`)
        minus++
      }
    }
    return {
      body: { kind: 'diff', text: lines.join('\n'), truncated: false },
      result: plus || minus ? `+${plus} −${minus}` : ''
    }
  }
  if (/^(Bash|BashOutput|PowerShell)$/.test(name)) {
    const out = [str(result?.stdout), str(result?.stderr)].filter(Boolean).join('\n') || text
    const code = num(result?.exitCode) ?? num(result?.exit_code)
    return {
      body: { kind: 'text', text: out, truncated: false },
      result: code ? `exit ${code}` : ''
    }
  }
  if (/^(Read|NotebookRead)$/.test(name)) {
    // Dropped entirely, not clipped: a read is the single largest thing in a
    // transcript and the least worth carrying — the card is collapsed anyway.
    const n = text ? text.split('\n').length : 0
    return { body: { kind: 'none', text: '', truncated: false }, result: n ? `${n} lines` : '' }
  }
  return { body: { kind: 'text', text, truncated: false }, result: '' }
}

/** Clip a body for the wire, leaving the full text for `chat:body` to serve. */
export function truncateBody(body: ChatToolBody): ChatToolBody {
  if (body.kind === 'none' || !body.text) return body
  const lines = body.text.split('\n')
  const max = body.kind === 'diff' ? DIFF_MAX_LINES : BASH_TAIL_LINES
  if (lines.length <= max) return body
  // A command's *tail* is the useful end; a diff's head is.
  const kept = body.kind === 'diff' ? lines.slice(0, max) : lines.slice(-max)
  return { kind: body.kind, text: kept.join('\n'), truncated: true }
}

/** `Your questions have been answered: "<q>"="<label>", …` — the one prose rule. */
function parseAnswers(text: string): string[] {
  const out: string[] = []
  // The mapper owns this string-matching and falls back to rendering the options
  // un-ticked when the format changes under us. It is the *only* prose-parsing
  // rule in the design, deliberately — a cancelled tool is detected structurally
  // (see markCancelled) precisely so this stays one and does not become a pattern.
  const re = /"[^"]*"="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

/** `AskUserQuestion`'s input, shared by the mapper and the live blocking card. */
export function parseQuestions(input: Json): ChatQuestion[] {
  const out: ChatQuestion[] = []
  for (const q of arr(input.questions)) {
    const o = obj(q)
    if (!o) continue
    const options: ChatQuestionOption[] = []
    for (const opt of arr(o.options)) {
      const oo = obj(opt)
      if (oo) options.push({ label: str(oo.label), description: str(oo.description) || undefined })
    }
    out.push({
      question: str(o.question),
      header: str(o.header) || undefined,
      multiSelect: o.multiSelect === true,
      options
    })
  }
  return out
}

export interface MapResult {
  entries: ChatEntry[]
  /** full tool bodies, by entry id — kept in main, fetched on expand */
  bodies: Map<string, string>
  /** the running todo fold, mutated in place by the caller's mapper */
  todos: Map<string, ChatTodo>
  /** last model seen, so a later pass can keep emitting `model · a → b` dividers */
  model: string | null
  /** sub-log rows keyed by their spawning tool_use id (stream only) */
  subagents: Map<string, ChatEntry[]>
}

/**
 * One conversation's mapper. Stateful across lines because a `tool_use` and its
 * `tool_result` are two of them, and because a model divider is *derived* from
 * consecutive assistant messages disagreeing rather than from a "you clicked the
 * chip" event — which gets the semantics right for free: switching and then not
 * taking a turn leaves no divider, because nothing ran differently.
 */
export class ChatMapper {
  readonly entries: ChatEntry[] = []
  readonly bodies = new Map<string, string>()
  readonly todos = new Map<string, ChatTodo>()
  readonly subagents = new Map<string, ChatEntry[]>()
  model: string | null = null

  private tools = new Map<string, { entry: ChatEntry; name: string; input: Json }>()
  private seq = 0
  private turn = 0
  /** index in `entries` where the current turn began, for the cancelled sweep */
  private turnStart = 0
  /** ids already handed out this pass — see blockId for why that can happen */
  private usedIds = new Set<string>()

  constructor(turn = 0) {
    this.turn = turn
  }

  setTurn(turn: number): void {
    this.turn = turn
    this.turnStart = this.entries.length
  }

  private id(prefix: string): string {
    return `${prefix}#${this.seq++}`
  }

  /**
   * The id of one content block's row.
   *
   * The block *type* is part of it, and that is load-bearing: Claude Code writes
   * one transcript line per content block but gives every line the same
   * `message.id`, so a message whose text and tool call are two lines yields two
   * blocks both at index 0. Without the type in the key the tool card would
   * overwrite the paragraph above it — verified on a real 2.1.211 transcript,
   * where `msg_011Cdc…` appeared once carrying `text` and once carrying
   * `tool_use`, both at index 0.
   *
   * The counter suffix is the backstop for the remaining case (two blocks of the
   * same type at the same index in one message). It is deliberately *not* used
   * for the first occurrence, so a partial-text row painted from `stream_event`
   * deltas — which computes this same id independently — upserts into the
   * finished `assistant` frame's row instead of duplicating it.
   */
  private blockId(msgId: string, index: number, type: string): string {
    const base = `${msgId}#${index}#${type}`
    if (!this.usedIds.has(base)) {
      this.usedIds.add(base)
      return base
    }
    let n = 2
    while (this.usedIds.has(`${base}#${n}`)) n++
    this.usedIds.add(`${base}#${n}`)
    return `${base}#${n}`
  }

  private push(e: ChatEntry): ChatEntry {
    this.entries.push(e)
    return e
  }

  /**
   * Feed one line (transcript) or frame (stream). `at` is the host-read
   * timestamp used when the envelope carries none.
   *
   * Returns the entries this line created or *changed* — a `tool_result` mutates
   * the card its `tool_use` already produced, and the renderer upserts by id.
   */
  feed(line: Json, at: number): ChatEntry[] {
    const before = this.entries.length
    const touched: ChatEntry[] = []
    const stamp = this.timeOf(line, at)

    // Subagent inner work is suppressed from the main log and never appended to
    // it: indenting it under the spawning row makes one subagent's bookkeeping
    // outweigh the conversation, and the log's whole argument is a single shared
    // left edge. It is buffered here instead and served as that row's sub-log.
    const parentId = str(line.parent_tool_use_id)
    if (parentId) {
      const sub = new ChatMapper(this.turn)
      sub.feed({ ...line, parent_tool_use_id: '' }, at)
      const list = this.subagents.get(parentId) ?? []
      list.push(...sub.entries)
      this.subagents.set(parentId, list)
      return []
    }

    switch (str(line.type)) {
      case 'user':
        this.user(line, stamp, touched)
        break
      case 'assistant':
        this.assistant(line, stamp)
        break
      case 'system':
        this.system(line, stamp)
        break
      default:
        break // whitelist: everything else is injected context or bookkeeping
    }

    for (let i = before; i < this.entries.length; i++) touched.push(this.entries[i])
    return touched
  }

  private timeOf(line: Json, fallback: number): number {
    const ts = str(line.timestamp)
    if (ts) {
      const t = Date.parse(ts)
      if (Number.isFinite(t)) return t
    }
    return fallback
  }

  // ---- user lines ---------------------------------------------------------
  private user(line: Json, at: number, touched: ChatEntry[]): void {
    // `isMeta` covers a slash command's expanded prompt: the command itself is
    // already recorded as a plain user row, and rendering both would show the
    // machinery twice. (No isSidechain test — see the note at the top.)
    if (line.isMeta === true) return
    const message = obj(line.message)
    if (!message) return
    const uuid = str(line.uuid) || this.id('u')
    const content = message.content

    if (typeof content === 'string') {
      this.userText(content, `${uuid}#0`, at, [])
      return
    }

    const chips: ChatChip[] = []
    const texts: { text: string; id: string }[] = []
    arr(content).forEach((block, i) => {
      const b = obj(block)
      if (!b) return
      const type = str(b.type)
      if (type === 'text') texts.push({ text: str(b.text), id: `${uuid}#${i}` })
      else if (type === 'image') chips.push({ kind: 'image', name: 'image' })
      else if (type === 'document') chips.push({ kind: 'document', name: str(b.title) || 'document' })
      else if (type === 'tool_result') {
        const done = this.toolResult(b, obj(line.toolUseResult) ?? obj(line.tool_use_result), at)
        if (done) touched.push(done)
      }
    })
    // Attachment blocks and their prose belong to one send; the chips ride the
    // first text row so a split-send reads as the single message it was.
    if (texts.length === 0 && chips.length > 0) {
      this.push({
        id: `${uuid}#chips`,
        role: 'you',
        at,
        turn: this.turn,
        kind: 'text',
        md: '',
        chips
      })
      return
    }
    texts.forEach((t, i) => this.userText(t.text, t.id, at, i === 0 ? chips : []))
  }

  private userText(raw: string, id: string, at: number, chips: ChatChip[]): void {
    const text = raw.replace(STRIP_TAGS, '').trim()
    if (!text) return

    // An interrupt is a row, not a state: a cut turn is an ordinary turn with one
    // extra row in it. Rendering this as a tinted `you` row — the default for a
    // user message with a plain text block — would be a lie, "as though you had
    // typed the words".
    if (text === INTERRUPT_MARKER) {
      this.push({
        id,
        role: 'stop',
        at,
        turn: this.turn,
        kind: 'stop',
        text: 'interrupted',
        tone: 'muted'
      })
      return
    }

    const cmd = COMMAND_RE.exec(text)
    if (cmd) {
      const args = (cmd[2] ?? '').trim()
      this.push({
        id,
        role: 'you',
        at,
        turn: this.turn,
        kind: 'text',
        md: `${cmd[1]}${args ? ` ${args}` : ''}`,
        chips: chips.length ? chips : undefined
      })
      return
    }

    // Pull the attached-path trailer back out into chips.
    const paths: ChatChip[] = []
    const body = text
      .replace(ATTACH_RE, (_m, inner: string) => {
        for (const p of inner.split('\n').map((s) => s.trim()).filter(Boolean)) {
          paths.push({ kind: 'path', name: p.split('/').pop() ?? p, detail: p })
        }
        return ''
      })
      .trim()
    const all = [...chips, ...paths]
    this.push({
      id,
      role: 'you',
      at,
      turn: this.turn,
      kind: 'text',
      md: body,
      chips: all.length ? all : undefined
    })
  }

  // ---- assistant lines ----------------------------------------------------
  private assistant(line: Json, at: number): void {
    const message = obj(line.message)
    if (!message) return
    const msgId = str(message.id) || str(line.uuid) || this.id('a')

    // Derived, not clicked: the row marks where the model actually changed.
    const model = str(message.model)
    if (model) {
      if (this.model && this.model !== model) {
        this.push({
          id: this.id('model'),
          role: 'claude',
          at,
          turn: this.turn,
          kind: 'divider',
          text: `model · ${shortModel(this.model)} → ${shortModel(model)}`
        })
      }
      this.model = model
    }

    arr(message.content).forEach((block, i) => {
      const b = obj(block)
      if (!b) return
      const type = str(b.type)
      const id = this.blockId(msgId, i, type)
      if (type === 'text') {
        const md = str(b.text).trim()
        if (md) this.push({ id, role: 'claude', at, turn: this.turn, kind: 'text', md })
      } else if (type === 'thinking' || type === 'redacted_thinking') {
        const md = str(b.thinking) || str(b.text)
        if (md) this.push({ id, role: 'think', at, turn: this.turn, kind: 'thinking', md })
      } else if (type === 'tool_use') {
        this.toolUse(b, id, at)
      }
    })
  }

  private toolUse(b: Json, id: string, at: number): void {
    const name = str(b.name)
    const input = obj(b.input) ?? {}
    const toolUseId = str(b.id) || id
    const role = roleForTool(name)

    if (role === 'todo') {
      // A one-line row per call, collapsed the way a read is — it changed nothing
      // on disk — so the log stays a complete record and nothing the agent did is
      // omitted. The *fold* (current state) is rebuilt separately, in main.
      const text =
        name === 'TaskCreate'
          ? `+ ${str(input.subject)}`
          : `${str(input.taskId)} · → ${str(input.status)}`
      const entry = this.push({ id, role: 'todo', at, turn: this.turn, kind: 'todo', text })
      this.tools.set(toolUseId, { entry, name, input })
      return
    }

    if (role === 'task') {
      // Live, the row is built straight off the tool call; the settled row costs
      // no extra read either, because the parent transcript's own toolUseResult
      // carries agentId/status/duration/tokens. Only *expanding* touches the
      // sibling file, on demand.
      const entry = this.push({
        id,
        role: 'task',
        at,
        turn: this.turn,
        kind: 'task',
        toolUseId,
        agentId: null,
        agentType: str(input.subagent_type) || 'agent',
        description: str(input.description) || compact(str(input.prompt), 80),
        status: 'running',
        durationMs: null,
        tools: null,
        tokens: null,
        running: true
      })
      this.tools.set(toolUseId, { entry, name, input })
      return
    }

    if (name === 'AskUserQuestion') {
      const entry = this.push({
        id,
        role: 'ask',
        at,
        turn: this.turn,
        kind: 'ask',
        questions: parseQuestions(input),
        answers: [],
        pending: true
      })
      this.tools.set(toolUseId, { entry, name, input })
      return
    }

    if (name === 'ExitPlanMode') {
      const entry = this.push({
        id,
        role: 'plan',
        at,
        turn: this.turn,
        kind: 'plan',
        md: str(input.plan),
        state: 'pending'
      })
      this.tools.set(toolUseId, { entry, name, input })
      return
    }

    const entry = this.push({
      id,
      role,
      at,
      turn: this.turn,
      kind: 'tool',
      toolUseId,
      title: toolTitle(name, input),
      result: '',
      status: 'running',
      body: { kind: 'none', text: '', truncated: false }
    })
    this.tools.set(toolUseId, { entry, name, input })
  }

  /** A tool_result completes the card its tool_use already produced. */
  private toolResult(b: Json, structured: Json | null, at: number): ChatEntry | null {
    const toolUseId = str(b.tool_use_id)
    const pending = this.tools.get(toolUseId)
    if (!pending) return null
    this.tools.delete(toolUseId)
    const { entry, name, input } = pending
    const isError = b.is_error === true
    const text = resultText(b.content)

    if (entry.kind === 'todo') {
      const id = str(structured?.taskId) || str(input.taskId)
      if (name === 'TaskCreate' && id) {
        this.todos.set(id, {
          id,
          subject: str(input.subject),
          activeForm: str(input.activeForm) || undefined,
          status: 'pending'
        })
        entry.text = `+ ${str(input.subject)}`
      } else if (id) {
        const status = str(input.status)
        const existing = this.todos.get(id)
        // `deleted` permanently removes a task — the strip is a mirror of what
        // the agent believes, so it has to lose the entry too.
        if (status === 'deleted') this.todos.delete(id)
        else if (existing) {
          const change = obj(structured?.statusChange)
          existing.status = (status || existing.status) as ChatTodo['status']
          entry.text = `${existing.subject} · ${str(change?.from) || 'pending'} → ${
            str(change?.to) || status
          }`
        }
      }
      return entry
    }

    if (entry.kind === 'task') {
      entry.agentId = str(structured?.agentId) || null
      entry.agentType = str(structured?.agentType) || entry.agentType
      entry.status = isError ? 'failed' : str(structured?.status) || 'completed'
      entry.durationMs = num(structured?.totalDurationMs)
      entry.tools = num(structured?.totalToolUseCount)
      entry.tokens = num(structured?.totalTokens)
      entry.running = false
      return entry
    }

    if (entry.kind === 'ask') {
      entry.pending = false
      entry.answers = parseAnswers(text)
      return entry
    }

    if (entry.kind === 'plan') {
      entry.state = isError ? 'denied' : 'approved'
      return entry
    }

    if (entry.kind !== 'tool') return entry
    const { body, result } = toolBody(name, input, structured, text)
    entry.status = isError ? 'error' : 'ok'
    entry.result = isError ? firstLine(text) || 'error' : result
    entry.body = body
    if (body.text) this.bodies.set(entry.id, body.text)
    if (roleForTool(name) === 'cmd') {
      // A Skill tool_use reads identically whether you typed it or Claude reached
      // for it — same `cmd` row either way.
      const md = body.text || text
      const replacement: ChatEntry = {
        id: entry.id,
        role: 'cmd',
        at: entry.at,
        turn: entry.turn,
        kind: 'cmd',
        title: entry.title,
        md,
        truncated: false
      }
      const i = this.entries.indexOf(entry)
      if (i >= 0) this.entries[i] = replacement
      return replacement
    }
    void at
    return entry
  }

  // ---- system lines -------------------------------------------------------
  private system(line: Json, at: number): void {
    const subtype = str(line.subtype)
    if (subtype === 'local_command') {
      // Promoted out of the drop list: without this row `/context` renders live
      // and then *vanishes* a second later at `result`, when the turn's entries
      // are replaced with transcript-derived ones.
      const raw = str(line.content)
      const m = LOCAL_STDOUT_RE.exec(raw)
      const md = (m ? m[1] : raw).trim()
      if (!md) return
      const id = str(line.uuid) || this.id('cmd')
      this.bodies.set(id, md)
      this.push({ id, role: 'cmd', at, turn: this.turn, kind: 'cmd', title: '', md, truncated: false })
      return
    }
    if (subtype === 'compact_boundary') {
      // Not decoration: without it the log reads as continuous when it is not,
      // and the user is left wondering why the agent re-reads a file it read.
      const meta = obj(line.compactMetadata) ?? obj(line.compact_metadata) ?? line
      const pre = num(meta.preTokens) ?? num(meta.pre_tokens)
      const post = num(meta.postTokens) ?? num(meta.post_tokens)
      const span = pre !== null && post !== null ? ` · ${tok(pre)} → ${tok(post)} tokens` : ''
      this.push({
        id: str(line.uuid) || this.id('compact'),
        role: 'claude',
        at,
        turn: this.turn,
        kind: 'divider',
        text: `compacted${span}`
      })
      return
    }
    if (subtype === 'turn_duration') {
      // Makes reloaded history *richer* than what the stream painted — the one
      // direction in which asymmetry is welcome.
      const ms = num(line.durationMs) ?? num(line.duration_ms) ?? num(line.duration)
      if (ms === null) return
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i]
        if (e.kind === 'turn') {
          e.durationMs = ms
          return
        }
      }
      this.push({
        id: this.id('turn'),
        role: 'run',
        at,
        turn: this.turn,
        kind: 'turn',
        startedAt: at - ms,
        durationMs: ms
      })
    }
  }

  // ---- turn-level sweeps --------------------------------------------------
  /**
   * Classify the tool calls an interrupt killed.
   *
   * **Position, not wording.** Reopened, a cancelled call and a genuinely failed
   * one are both `is_error: true`, so the rule is: the error tool_results with
   * nothing after them in the turn but the interrupt marker are the cancelled
   * ones. A tool that really failed earlier always has assistant blocks after it,
   * because the agent kept going.
   */
  markCancelled(from = this.turnStart): void {
    for (let i = this.entries.length - 1; i >= from; i--) {
      const e = this.entries[i]
      if (!(e.kind === 'stop' && e.text === 'interrupted')) continue
      for (let j = i - 1; j >= from; j--) {
        const prev = this.entries[j]
        if (prev.kind === 'tool') {
          if (prev.status !== 'error') break
          prev.status = 'cancelled'
          // The synthetic result carries only "The user doesn't want to proceed
          // with this tool use…", so an open card would be a card showing nothing.
          prev.result = 'cancelled'
          prev.body = { kind: 'none', text: '', truncated: false }
          continue
        }
        if (prev.kind === 'plan') {
          // A denied plan sitting above the marker was cancelled, not denied —
          // which is what actually happened to it.
          if (prev.state === 'denied') prev.state = 'cancelled'
          continue
        }
        if (prev.kind === 'ask' || prev.kind === 'todo' || prev.kind === 'task') continue
        break
      }
      return
    }
  }

  /**
   * Close a whole-file pass. A transcript whose final entry is a `user` message
   * with no assistant reply is a turn whose process died mid-stream: killing the
   * in-container `claude` is completely silent — no result, no error line, no
   * terminal_reason — so the file holds the prompt and nothing else. Without this
   * a reopened chat shows a user message followed by nothing, which reads as a
   * lost message.
   *
   * The partial text the user watched stream is *not* recoverable here, because
   * none was ever written. That is the one place live-equals-reopened
   * structurally cannot hold, and it is stated rather than papered over.
   */
  finishHistory(at: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.kind === 'text' && e.role === 'you') {
        this.push({
          id: this.id('stop'),
          role: 'stop',
          at,
          turn: this.turn,
          kind: 'stop',
          text: 'no reply — the CLI stopped before answering',
          tone: 'alert',
          retry: true
        })
      }
      // Anything else as the final entry means the turn produced *something*.
      return
    }
  }
}

function tok(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** `claude-opus-5-20260101` → `opus-5`; anything unrecognised passes through. */
function shortModel(id: string): string {
  const m = /^claude-([a-z]+(?:-[0-9.]+)?)/.exec(id)
  return m ? m[1] : id
}

export { roleForTool, shortModel, toolTitle }

/** Parse an NDJSON blob into objects, counting the lines that would not parse. */
export function parseNdjson(text: string): { lines: Json[]; malformed: number } {
  const lines: Json[] = []
  let malformed = 0
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    try {
      const o = obj(JSON.parse(t))
      if (o) lines.push(o)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { lines, malformed }
}

export type { ChatToolStatus }
