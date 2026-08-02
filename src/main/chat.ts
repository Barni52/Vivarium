import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'node:crypto'
import type {
  AgentActivityEvent,
  ChatAnswer,
  ChatAttachment,
  ChatBlockingCard,
  ChatContextUsage,
  ChatEntry,
  ChatEvent,
  ChatMode,
  ChatModelOption,
  ChatOpenResult,
  ChatState,
  ChatTodo,
  Project,
  Session
} from '@shared/types'
import type { DockerService } from './docker'
import {
  ATTACH_CLOSE,
  ATTACH_OPEN,
  ChatMapper,
  completeLines,
  parseNdjson,
  parseQuestions,
  takeTurn,
  textBlockId,
  truncateBody
} from './chatMapper'

// One live Claude Code CLI process per chat session, keyed by session id — the
// same shape as PtyManager, and for the same reason. What is different is that
// nothing here is unrecoverable: the *conversation* lives in the container-side
// transcript, so the chat has no terminal states. Every failure below is
// recovered in place by the same single act — respawn the process and re-read
// the transcript — and nothing is lost by respawning that was not already lost.

type Json = Record<string, unknown>
type Emit = (event: ChatEvent) => void
type EmitActivity = (e: AgentActivityEvent) => void

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

/**
 * Total assistant prose in a set of rows. Tool cards and clocks are excluded on
 * purpose: they are reproduced identically by both sources, so only the prose
 * can tell a transcript that is one line behind from one that is complete.
 */
function prose(entries: ChatEntry[]): number {
  let n = 0
  for (const e of entries) if (e.kind === 'text' && e.role === 'claude') n += e.md.length
  return n
}

/**
 * A turn is failed when the stream has produced no frame **of any kind** for
 * this long after the user's message.
 *
 * There is no error to detect otherwise: run against a broken credential the CLI
 * emits a normal-looking `system/init` — full tool list, model, permissionMode —
 * and then produces nothing at all. No error, no result, no exit, still alive at
 * 45s, stderr silent. The threshold is on *any* frame rather than on `result`
 * because a working turn emits assistant and system frames continuously
 * (thinking, tool calls, task progress) while the broken CLI emitted precisely
 * zero after init, which is what makes 60s safe against a genuinely long turn in
 * a way a result-based timeout never could be.
 */
const SILENCE_MS = 60_000

/** How many entries the renderer mounts; the rest come from `chat:earlier`. */
const MOUNT_WINDOW = 300

/**
 * How long after a turn's `result` to re-read the transcript, when the first
 * settle came back with less prose than the stream had already painted.
 *
 * `result` arrives over a pipe and the transcript is a file the CLI is writing
 * on its own schedule, so the two are not ordered against each other: the last
 * assistant line is occasionally still in flight when the settle reads. Since a
 * settle *replaces* the turn, losing that race deleted the final paragraph of
 * the answer from a log that had just finished painting it. One delayed re-read,
 * fired only on evidence that something is missing, costs a `docker exec` in the
 * rare case and nothing at all in the common one.
 */
const RESETTLE_MS = 700

/**
 * What the picker offers when `list_models` answers with nothing — an old CLI,
 * a control request it does not implement, or a timed-out round trip.
 *
 * These are the aliases Claude Code has accepted for `--model` throughout, and
 * they resolve on the CLI's side, so a stale entry here can only mis-suggest,
 * never mis-execute — the same argument that lets `Project.slashCommands` be
 * cached. An empty menu, by contrast, leaves the chip unusable with no way to
 * tell whether the account has no models or the request simply failed.
 */
const FALLBACK_MODELS: ChatModelOption[] = [
  { value: 'default', label: 'Default', detail: 'whatever the CLI is configured for' },
  { value: 'opus', label: 'Opus', detail: 'the latest Opus' },
  { value: 'sonnet', label: 'Sonnet', detail: 'the latest Sonnet' },
  { value: 'haiku', label: 'Haiku', detail: 'the latest Haiku' }
]

/**
 * The assistant message being streamed right now.
 *
 * `stream_event` numbers content blocks across the whole message while the
 * transcript writes one block per line (index always 0), so the delta's index
 * cannot be used as an id — it is translated here into the per-type ordinal
 * `ChatMapper` counts, via `textBlockId`. Only text blocks are painted, so only
 * text blocks claim an ordinal, and they claim it in arrival order, which is the
 * order the mapper will see them in too.
 */
interface Streaming {
  msgId: string
  at: number
  /** content-block index → the row id it was given */
  ids: Map<number, string>
  /** text accumulated per content-block index */
  text: Map<number, string>
  /** how many text blocks this message has opened */
  texts: number
}

interface Live {
  session: Session
  project: Project
  proc: ChildProcessWithoutNullStreams | null
  /** partial NDJSON line carried between stdout chunks */
  stdout: string
  /** everything main holds — the renderer gets a clipped tail of it */
  entries: ChatEntry[]
  /** full tool bodies by entry id, so a 10 MB transcript is never a 10 MB clone */
  bodies: Map<string, string>
  todos: Map<string, ChatTodo>
  /** live sub-log frames, by their spawning tool_use id */
  subagents: Map<string, ChatEntry[]>
  /** byte offset into the transcript that has already been mapped */
  offset: number
  /**
   * Where the running turn's lines begin. A settle re-maps the turn from here
   * rather than from wherever the last read stopped, which is what makes
   * settling the same turn twice idempotent — the second pass replaces the same
   * rows with the same ids instead of appending a second copy of them.
   */
  turnOffset: number
  /**
   * Whether the conversation already has a transcript, when the read could tell.
   * `undefined` after a *failed* read — then execArgs must fall back to its own
   * probe, or a session whose file exists would be launched with `--session-id`
   * and the CLI would refuse the id as already in use.
   */
  transcriptExists: boolean | undefined
  turn: number
  /** the turn's mapper, kept so tool_use → tool_result pairing spans frames */
  mapper: ChatMapper | null
  /** outstanding can_use_tool requests — *any* of them means `waiting` */
  pending: Map<string, ChatBlockingCard>
  /** our own control requests, awaiting their response */
  waiters: Map<string, (r: { ok: boolean; response: Json | null; error: string }) => void>
  reqSeq: number
  /** lines that would not parse, counted per turn and surfaced only on a stop row */
  malformed: number
  silence: ReturnType<typeof setTimeout> | null
  model: string | null
  commands: string[]
  context: ChatContextUsage | null
  /** the assistant message currently streaming, for partial-text painting */
  streaming: Streaming | null
  turnRunning: boolean
  /** set by an interrupt so the turn's `idle` raises no attention flag */
  interrupted: boolean
  closing: boolean
}

export class ChatService {
  private live = new Map<string, Live>()
  /**
   * The `list_models` answer, cached for the app run. In memory, never in
   * config.json: the list is global to the account and CLI version, so sharding
   * it per project the way the slash-command cache is sharded would fragment a
   * global fact — and persisting it would be a third dent in a rule this feature
   * already dents twice. A stale entry can only mis-suggest.
   */
  private models: ChatModelOption[] | null = null
  /**
   * The `input` object each outstanding can_use_tool arrived with, so the answer
   * can rebuild `updatedInput` from the original rather than from what the
   * renderer echoes back.
   */
  private inputs = new Map<string, Json>()

  constructor(
    private docker: DockerService,
    private emit: Emit,
    private emitActivity: EmitActivity,
    /** persist a /clear's new conversation id, and retire the outgoing one */
    private onConversationReset: (sessionId: string, next: string, previous: string) => void,
    /** cache a project's slash-command names so a cold chat has a menu */
    private onCommands: (projectId: string, commands: string[]) => void,
    /** a rate_limit_event tops up the title bar's existing chips */
    private onRateLimit: (five: Json | null, seven: Json | null) => void
  ) {}

  has(sessionId: string): boolean {
    return this.live.has(sessionId)
  }

  liveIds(): string[] {
    return [...this.live.keys()]
  }

  // ---- open / close -------------------------------------------------------
  /**
   * Probe, read the transcript, spawn — under one caller-held gate slot, exactly
   * like a terminal agent's open. The middle step is no longer a probe though:
   * the transcript is read whole (10.6 MB was the largest in a 20-session
   * sample, and pairing tool_use to tool_result wants the full sweep anyway), so
   * the slot is now held for a bulk transfer.
   */
  async open(project: Project, session: Session, retry = false): Promise<ChatOpenResult> {
    const existing = this.live.get(session.id)
    if (existing && !retry) return { ok: true, state: this.stateOf(existing) }
    if (existing) this.close(session.id)

    if (!(await this.docker.binaryName())) {
      return { ok: false, reason: 'docker-missing', message: 'docker not found on PATH' }
    }
    // Opening a session must never start a stopped container — starting stays an
    // explicit user action, and the placeholder that says so is also the one
    // screen where "no history while the container is stopped" becomes visible.
    if (!(await this.docker.isRunning(project))) return { ok: false, reason: 'container-stopped' }

    const l: Live = {
      session,
      project,
      proc: null,
      stdout: '',
      entries: [],
      bodies: new Map(),
      todos: new Map(),
      subagents: new Map(),
      offset: 0,
      turnOffset: 0,
      transcriptExists: undefined,
      turn: 0,
      mapper: null,
      pending: new Map(),
      waiters: new Map(),
      reqSeq: 0,
      malformed: 0,
      silence: null,
      model: session.model ?? null,
      commands: project.slashCommands ?? [],
      context: null,
      streaming: null,
      turnRunning: false,
      interrupted: false,
      closing: false
    }

    const historyError = await this.readHistory(l)
    if (!(await this.start(l))) return { ok: false, reason: 'spawn-failed' }
    this.live.set(session.id, l)

    // The open-time context reading is the load-bearing half of the cadence:
    // nothing is emitted on the wire until the first user message, so a chat
    // reopened onto 80k of history has a live process that has said nothing about
    // itself, and refreshing only at turn end would show an empty meter at
    // exactly the moment you look at it. The control channel, unlike the message
    // stream, is live from spawn.
    void this.refreshContext(l)

    const state = this.stateOf(l)
    if (historyError) state.historyError = historyError
    return { ok: true, state }
  }

  close(sessionId: string): void {
    const l = this.live.get(sessionId)
    if (!l) return
    l.closing = true
    if (l.silence) clearTimeout(l.silence)
    try {
      l.proc?.kill()
    } catch {
      /* already gone */
    }
    this.live.delete(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.live.keys()]) this.close(id)
  }

  private stateOf(l: Live): ChatState {
    return {
      entries: this.wireEntries(l.entries.slice(-MOUNT_WINDOW)),
      total: l.entries.length,
      todos: [...l.todos.values()],
      mode: l.session.mode ?? 'bypassPermissions',
      model: l.model,
      commands: l.commands,
      context: l.context,
      blocking: [...l.pending.values()][0] ?? null
    }
  }

  /** Clip tool bodies on the way out, keeping the full text for `chat:body`. */
  private wireEntries(entries: ChatEntry[]): ChatEntry[] {
    return entries.map((e) => {
      if (e.kind === 'tool' && e.body.text) {
        const body = truncateBody(e.body)
        return body === e.body ? e : { ...e, body }
      }
      if (e.kind === 'cmd' && e.md.split('\n').length > 60) {
        return { ...e, md: e.md.split('\n').slice(0, 60).join('\n'), truncated: true }
      }
      return e
    })
  }

  // ---- transcript ---------------------------------------------------------
  /**
   * Read the whole conversation and map it. Returns an error string when the
   * read failed — the chat stays usable in that case (the process spawns fine,
   * only the history is missing), so this becomes a banner rather than a
   * takeover, and it clears on a successful read rather than on a dismiss.
   */
  private async readHistory(l: Live): Promise<string | undefined> {
    const uuid = l.session.claudeSessionId
    if (!uuid) {
      l.transcriptExists = false
      return undefined
    }
    const r = await this.docker.readTranscript(l.project, uuid, 0)
    if (!r.ok) return r.message || 'could not read the conversation'
    // Whole lines only — a read that lands mid-line must leave that line to the
    // next read rather than consume half of it (see completeLines).
    const { complete, bytes } = completeLines(r.text)
    l.offset = bytes
    l.turnOffset = bytes
    l.transcriptExists = r.bytes > 0
    const mapper = new ChatMapper(0)
    const { lines } = parseNdjson(complete)
    const now = Date.now()
    for (const line of lines) mapper.feed(line, now)
    mapper.markCancelled(0)
    mapper.finishHistory(now)
    l.entries = mapper.entries
    l.bodies = mapper.bodies
    l.todos = mapper.todos
    l.model = mapper.model ?? l.model
    // A history turn is turn 0; live turns start at 1 so a settle can never
    // replace history it did not map.
    l.turn = 0
    return undefined
  }

  /**
   * Turn-end settle: re-read the bytes this turn appended, map them, and replace
   * this turn's rows with the transcript-derived ones.
   *
   * This is what makes anything more than a few seconds old always
   * transcript-derived — the same bytes a restart would render. It is
   * incremental rather than a whole-file re-read, which also picks up lines
   * written by *another* client on the same conversation for free.
   *
   * It reads from the turn's own start offset rather than from wherever the last
   * read stopped, so running it twice on one turn replaces the same rows instead
   * of appending a second copy — which is what lets a late flush be recovered by
   * simply doing it again.
   */
  private async settleTurn(l: Live, turn: number, from: number, retry = true): Promise<void> {
    const uuid = l.session.claudeSessionId
    if (!uuid) return
    const r = await this.docker.readTranscript(l.project, uuid, from)
    if (!r.ok || !r.text.trim()) return
    const { complete } = completeLines(r.text)
    if (!complete) return
    // One turn per settle: a queued follow-up is already in the file by the time
    // this read lands, and mapping it here would stamp it with the turn above it.
    const { lines, bytes } = takeTurn(complete)
    this.accounted(l, from + bytes)
    const mapper = new ChatMapper(turn)
    const now = Date.now()
    for (const line of lines) mapper.feed(line, now)
    mapper.markCancelled(0)
    if (mapper.entries.length === 0) return

    // How much prose the stream painted, against how much the transcript holds.
    // A settle is a *replacement*, so a file still one line behind deletes the
    // paragraph the user just watched arrive; comparing the two is the evidence
    // that says "read again in a moment" instead of guessing at a delay.
    const painted = prose(l.entries.filter((e) => e.turn === turn))
    const landed = prose(mapper.entries)

    // Fold the mapped todos into the running fold rather than replacing it: the
    // fold spans the whole conversation and the mount window is only the tail, so
    // a renderer-side fold would lose a task created 400 entries ago.
    for (const [id, t] of mapper.todos) l.todos.set(id, t)
    for (const [id, body] of mapper.bodies) l.bodies.set(id, body)
    if (mapper.model) l.model = mapper.model

    // Keep the turn's clock row: it is the only row in a turn that the transcript
    // cannot reproduce until `system/turn_duration` lands, and dropping it would
    // make the freeze look like a disappearance.
    const clock = l.entries.filter((e) => e.turn === turn && e.kind === 'turn')
    const settled = [...clock, ...mapper.entries]
    l.entries = [...l.entries.filter((e) => e.turn !== turn), ...settled]
    this.emit({
      kind: 'turn-settled',
      sessionId: l.session.id,
      turn,
      entries: this.wireEntries(settled)
    })
    this.emit({ kind: 'todo', sessionId: l.session.id, todos: [...l.todos.values()] })

    // Once, and only on evidence. A turn that genuinely ended there would re-read
    // forever on a standing rule, and the second pass reads from the same `from`
    // so it replaces these rows rather than appending beside them.
    if (retry && landed < painted) {
      setTimeout(() => {
        // Not if a follow-up has since started: the missing line is only worth
        // chasing while this is still the turn at the bottom of the log.
        if (this.live.get(l.session.id) !== l || l.turn !== turn) return
        void this.settleTurn(l, turn, from, false)
      }, RESETTLE_MS)
    }
  }

  // ---- process ------------------------------------------------------------
  /** Start the CLI. `-i`, never `-it` — there is no TTY anywhere in this path. */
  private async start(l: Live): Promise<boolean> {
    const bin = await this.docker.binaryName()
    if (!bin) return false
    // The transcript read just told us whether the conversation exists, so
    // execArgs picks --resume vs --session-id without a fourth docker launch.
    const args = await this.docker.execArgs(l.project, 'chat', l.session.id, l.transcriptExists)
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(bin, args, { windowsHide: true })
    } catch {
      return false
    }
    l.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onStdout(l, chunk))
    proc.stderr.on('data', () => {
      /* the CLI's stderr is diagnostic noise; the stream is the interface */
    })
    proc.on('error', () => this.onExit(l, 1))
    proc.on('close', (code) => this.onExit(l, code ?? 0))
    return true
  }

  private onExit(l: Live, code: number): void {
    if (l.closing) return
    if (l.silence) clearTimeout(l.silence)
    l.silence = null
    l.proc = null
    // Killing the in-container `claude` mid-stream is completely silent: no
    // result, no error line, no terminal_reason, and not one torn line even under
    // SIGKILL. The exit code is the only signal there is — and 137 vs 1 is the
    // difference between "the container was OOM-killed" and "the CLI fell over",
    // which is the only diagnostic the user gets.
    if (l.turnRunning) {
      const bad = l.malformed > 0 ? ` · ${l.malformed} malformed lines` : ''
      this.appendEntries(l, [
        {
          id: `exit:${l.turn}`,
          role: 'stop',
          at: Date.now(),
          turn: l.turn,
          kind: 'stop',
          text: `claude exited (code ${code})${bad}`,
          tone: 'alert',
          retry: true
        }
      ])
      this.dropTurnClock(l)
      this.setActivity(l, 'idle', true)
      l.turnRunning = false
    }
    this.emit({ kind: 'exit', sessionId: l.session.id, exitCode: code })
    this.live.delete(l.session.id)
  }

  // ---- NDJSON framing -----------------------------------------------------
  private onStdout(l: Live, chunk: string): void {
    this.armSilence(l)
    l.stdout += chunk
    let nl = l.stdout.indexOf('\n')
    while (nl >= 0) {
      const line = l.stdout.slice(0, nl).trim()
      l.stdout = l.stdout.slice(nl + 1)
      if (line) {
        try {
          const parsed = obj(JSON.parse(line))
          if (parsed) this.frame(l, parsed)
          else l.malformed++
        } catch {
          // Dropped, following the bridge watcher's precedent that a half-written
          // line must never reach the store as an event. A *visible* marker per
          // fragmented write would turn one bad write into garbage across a
          // healthy turn, so it is counted instead and surfaced only on a row
          // that was already going to be shown.
          l.malformed++
        }
      }
      nl = l.stdout.indexOf('\n')
    }
  }

  private write(l: Live, payload: Json): void {
    if (!l.proc?.stdin.writable) return
    l.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private armSilence(l: Live): void {
    if (l.silence) clearTimeout(l.silence)
    if (!l.turnRunning) {
      l.silence = null
      return
    }
    l.silence = setTimeout(() => this.onSilence(l), SILENCE_MS)
  }

  private onSilence(l: Live): void {
    l.silence = null
    if (!l.turnRunning) return
    l.turnRunning = false
    this.appendEntries(l, [
      {
        id: `timeout:${l.turn}`,
        role: 'stop',
        at: Date.now(),
        turn: l.turn,
        kind: 'stop',
        text: 'no response for 60s',
        tone: 'alert',
        retry: true
      }
    ])
    this.dropTurnClock(l)
    this.setActivity(l, 'idle', true)
    this.emit({
      kind: 'error',
      sessionId: l.session.id,
      // The usage endpoint's auth-expired is a *different* fact and can be
      // healthy while the CLI is broken (or the reverse), so it never gates the
      // chat — but when it happens to be set, it is the likeliest cause and the
      // row can point at the remedy the app already has.
      error: { kind: 'timeout', message: 'the CLI answered nothing for 60s' }
    })
  }

  // ---- frame handling -----------------------------------------------------
  private frame(l: Live, f: Json): void {
    const type = str(f.type)

    if (type === 'control_request') return this.controlRequest(l, f)
    if (type === 'control_response') return this.controlResponse(l, f)
    if (type === 'stream_event') return this.streamEvent(l, f)
    if (type === 'rate_limit_event') {
      // Two shapes are accepted because only one of them was observable. On
      // 2.1.211 the event is `{rate_limit_info: {status, resetsAt,
      // rateLimitType: 'five_hour', overageStatus, …}}` — it carries a *status*
      // and a reset time but **no utilisation percentage at all**, so there is
      // nothing to top the title-bar chips up with and the merge below no-ops.
      // The flat `{five_hour, seven_day}` form the design was written against
      // would carry one, so it is read too rather than guessed at later.
      const info = obj(f.rate_limit_info)
      if (info) {
        const kind = str(info.rateLimitType)
        const window = { utilization: info.utilization, resets_at: info.resetsAt }
        this.onRateLimit(kind === 'five_hour' ? window : null, kind === 'seven_day' ? window : null)
      } else {
        this.onRateLimit(obj(f.five_hour), obj(f.seven_day))
      }
      return
    }
    if (type === 'conversation_reset' || (type === 'system' && str(f.subtype) === 'conversation_reset')) {
      return this.reset(l, str(f.new_conversation_id) || str(f.session_id))
    }
    if (type === 'result') return this.result(l, f)

    if (type === 'system') {
      const subtype = str(f.subtype)
      if (subtype === 'init') return this.init(l, f)
      if (subtype === 'task_started' || subtype === 'task_updated') return this.taskEvent(l, f)
      // compact_boundary / turn_duration fall through to the mapper.
    }

    if (type === 'assistant') {
      // The turn is producing output, so it is working — and this is the only
      // place that has to say so, because the derivation costs no extra parsing:
      // main is already reading every message to render the log.
      this.setActivity(l, 'working')
    }

    const mapper = this.mapperFor(l)
    const touched = mapper.feed(f, Date.now())
    // Subagent frames are buffered by the mapper rather than appended; ship them
    // as that row's sub-log so an expanded task grows while the turn runs.
    for (const [toolUseId, rows] of mapper.subagents) {
      if (rows.length === 0) continue
      const merged = [...(l.subagents.get(toolUseId) ?? []), ...rows]
      l.subagents.set(toolUseId, merged)
      this.emit({ kind: 'task', sessionId: l.session.id, toolUseId, entries: rows })
      mapper.subagents.set(toolUseId, [])
    }
    if (touched.length) {
      for (const [id, body] of mapper.bodies) l.bodies.set(id, body)
      this.upsert(l, touched)
      const todos = [...mapper.todos.values()]
      if (todos.length) {
        for (const t of todos) l.todos.set(t.id, t)
        this.emit({ kind: 'todo', sessionId: l.session.id, todos: [...l.todos.values()] })
      }
    }
  }

  private mapperFor(l: Live): ChatMapper {
    if (!l.mapper) {
      l.mapper = new ChatMapper(l.turn)
      l.mapper.model = l.model
    }
    return l.mapper
  }

  private init(l: Live, f: Json): void {
    const model = str(f.model)
    if (model) l.model = model
    const commands = [
      ...arr(f.slash_commands).map((c) => str(c)),
      ...arr(f.skills).map((s) => {
        const o = obj(s)
        return o ? str(o.name) : str(s)
      })
    ].filter(Boolean)
    if (commands.length) {
      l.commands = commands
      this.onCommands(l.project.id, commands)
    }
    const mode = str(f.permissionMode)
    this.emit({
      kind: 'meta',
      sessionId: l.session.id,
      model: model || undefined,
      mode: mode === 'plan' || mode === 'bypassPermissions' ? mode : undefined,
      commands: commands.length ? commands : undefined
    })
  }

  /** Token deltas — prose paints as it is generated instead of landing at once. */
  private streamEvent(l: Live, f: Json): void {
    if (str(f.parent_tool_use_id)) return // subagent chatter, suppressed from the main log
    const ev = obj(f.event)
    if (!ev) return
    const kind = str(ev.type)
    if (kind === 'message_start') {
      const msg = obj(ev.message)
      l.streaming = {
        msgId: str(msg?.id) || 'stream',
        at: Date.now(),
        ids: new Map(),
        text: new Map(),
        texts: 0
      }
      return
    }
    if (kind !== 'content_block_delta') return
    const delta = obj(ev.delta)
    if (str(delta?.type) !== 'text_delta') return
    const s = l.streaming
    if (!s) return
    const index = num(ev.index) ?? 0
    let id = s.ids.get(index)
    if (id === undefined) {
      // The delta's index counts blocks across the whole message; the mapper
      // counts them per type, because the transcript writes one block per line
      // and always calls it index 0. Translating here is what keeps a partial row
      // and its settled row the same row (see ChatMapper.blockId).
      id = textBlockId(s.msgId, s.texts++)
      s.ids.set(index, id)
    }
    const md = (s.text.get(index) ?? '') + str(delta?.text)
    s.text.set(index, md)
    // Provisional: the `assistant` frame that follows computes this same id, so
    // it upserts over this row rather than duplicating it.
    this.upsert(l, [{ id, role: 'claude', at: s.at, turn: l.turn, kind: 'text', md }])
  }

  private taskEvent(l: Live, f: Json): void {
    const toolUseId = str(f.tool_use_id) || str(f.toolUseId)
    if (!toolUseId) return
    const entry = l.entries.find((e) => e.kind === 'task' && e.toolUseId === toolUseId)
    if (!entry || entry.kind !== 'task') return
    if (str(f.subtype) === 'task_updated') {
      entry.running = false
      entry.status = str(f.status) || 'completed'
      entry.durationMs = num(f.duration_ms) ?? entry.durationMs
      // Emitted, not silently folded into main's copy: the renderer holds its own
      // rows, so a task row that is not shipped stays spinning on screen until the
      // turn's settle lands — which for a long turn is minutes later.
      this.upsert(l, [entry])
    }
  }

  private result(l: Live, f: Json): void {
    if (l.silence) clearTimeout(l.silence)
    l.silence = null
    const turn = l.turn
    const reason = str(f.terminal_reason)
    // `is_error` cannot discriminate a user interrupt from a failure — a clean
    // deny-then-interrupt reports is_error: true — so terminal_reason is the only
    // test, and it is the only one used anywhere in this file.
    const aborted = reason === 'aborted_streaming' || reason === 'aborted_tools'
    const from = l.turnOffset
    l.turnRunning = false
    l.streaming = null

    if (aborted) {
      this.appendEntries(l, [
        {
          id: `stop:${turn}`,
          role: 'stop',
          at: Date.now(),
          turn,
          kind: 'stop',
          text: 'interrupted',
          tone: 'muted'
        }
      ])
      // An interrupted turn has nothing to freeze to: turn_duration is a
      // transcript line type and a killed turn writes no assistant line at all.
      // Manufacturing a number was rejected on both routes — one subtracts across
      // two clocks, the other invents a figure Claude Code never reported, in the
      // one case where the reading has no meaning. The gutter already stamps
      // hh:mm on the `you` row and this one.
      this.dropTurnClock(l)
    } else {
      this.freezeTurnClock(l, num(f.duration_ms))
    }

    // Suppressed at the same branch that reads terminal_reason for the stop row:
    // you ended it, and being told it ended is noise.
    this.setActivity(l, 'idle', aborted || l.interrupted)
    l.interrupted = false
    l.mapper = null

    // The degradation path that lost the vote survives as exactly that: when
    // get_context_usage fails the meter derives from result.usage and goes
    // approximate rather than absent.
    void this.refreshContext(l, obj(f.usage))

    if (!aborted) void this.settleTurn(l, turn, from)
    // An aborted turn keeps its streamed rows — there is nothing better to
    // replace them with — but its lines still went into the file, so the offset
    // has to step over them or the *next* turn's settle would map them again and
    // stamp them with the next turn's number, duplicating the whole cut turn.
    else void this.skipTurn(l, from)
    l.malformed = 0
  }

  /**
   * Advance past a turn's transcript lines without rendering them. Used where a
   * settle would be wrong (an interrupt) but the bytes still have to be accounted
   * for, since every later read is relative to this offset.
   */
  private async skipTurn(l: Live, from: number): Promise<void> {
    const uuid = l.session.claudeSessionId
    if (!uuid) return
    const r = await this.docker.readTranscript(l.project, uuid, from)
    if (!r.ok) return
    this.accounted(l, from + takeTurn(completeLines(r.text).complete).bytes)
  }

  /**
   * Record that the transcript is mapped up to `to`.
   *
   * `turnOffset` moves with it rather than only at `send`, because both reads
   * above are a `docker exec` round trip: a user who types the next message
   * during it would otherwise have snapshotted the *previous* turn's start, and
   * that turn's lines would be mapped a second time under the new turn's number.
   * The re-settle is unaffected — it holds its own `from` in a local.
   */
  private accounted(l: Live, to: number): void {
    l.offset = Math.max(l.offset, to)
    l.turnOffset = Math.max(l.turnOffset, l.offset)
  }

  private reset(l: Live, next: string): void {
    const previous = l.session.claudeSessionId
    const id = next || randomUUID()
    if (previous && previous !== id) this.onConversationReset(l.session.id, id, previous)
    l.session = { ...l.session, claudeSessionId: id }
    l.entries = []
    l.bodies.clear()
    l.todos.clear()
    l.subagents.clear()
    l.offset = 0
    l.turnOffset = 0
    l.streaming = null
    l.mapper = null
    this.emit({ kind: 'reset', sessionId: l.session.id, claudeSessionId: id })
    this.emit({ kind: 'todo', sessionId: l.session.id, todos: [] })
  }

  // ---- the control channel ------------------------------------------------
  /**
   * Tool permission, ExitPlanMode and AskUserQuestion all arrive as the *same*
   * `can_use_tool` request and are answered with the same result. One handler,
   * not three — and `requires_user_interaction: true` is the CLI asserting the
   * native-card requirement rather than us preferring it: one-tap Approve/Deny
   * must not be offered, the tool's card *is* the user-interaction surface.
   * bypassPermissions does not suppress either blocking tool.
   */
  private controlRequest(l: Live, f: Json): void {
    const requestId = str(f.request_id)
    const req = obj(f.request)
    if (!requestId || !req) return
    const subtype = str(req.subtype)

    if (subtype !== 'can_use_tool') {
      // A host that ignores an unknown dialog kind parks a future tool forever,
      // and asks never time out — a card dropped by the UI is a permanently stuck
      // agent. So anything we do not understand is answered, not ignored.
      this.write(l, {
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'cancelled' } }
      })
      return
    }

    const toolName = str(req.tool_name)
    const input = obj(req.input) ?? {}
    const card: ChatBlockingCard = {
      requestId,
      kind: toolName === 'ExitPlanMode' ? 'plan' : toolName === 'AskUserQuestion' ? 'question' : 'tool',
      toolName,
      toolUseId: str(req.tool_use_id) || undefined,
      title:
        toolName === 'ExitPlanMode'
          ? 'Plan awaiting approval'
          : toolName === 'AskUserQuestion'
            ? 'Claude has a question'
            : str(req.description) || `Allow ${toolName}?`,
      md: toolName === 'ExitPlanMode' ? str(input.plan) : undefined,
      questions: toolName === 'AskUserQuestion' ? parseQuestions(input) : undefined,
      at: Date.now()
    }
    // Remembered so the answer can rebuild `updatedInput` from the original.
    this.inputs.set(requestId, input)
    l.pending.set(requestId, card)
    this.emit({ kind: 'blocking', sessionId: l.session.id, card })
    // `waiting` is *any* pending can_use_tool, not just the two
    // requires_user_interaction tools: bypass does not dissolve the
    // working-directory guard, so an out-of-mounts Read still prompts, and that
    // blocks the turn on a human just as much as a plan does. The hook bridge
    // cannot see this case at all, which makes chat's reading strictly more
    // correct than the pty's rather than an approximation of it.
    this.setActivity(l, 'waiting')
  }

  private controlResponse(l: Live, f: Json): void {
    const r = obj(f.response)
    if (!r) return
    const requestId = str(r.request_id)
    const waiter = l.waiters.get(requestId)
    if (!waiter) return
    l.waiters.delete(requestId)
    waiter({
      ok: str(r.subtype) === 'success',
      response: obj(r.response),
      error: str(r.error)
    })
  }

  private request(
    l: Live,
    request: Json,
    timeoutMs = 15_000
  ): Promise<{ ok: boolean; response: Json | null; error: string }> {
    const requestId = `viv_${l.session.id}_${l.reqSeq++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        l.waiters.delete(requestId)
        resolve({ ok: false, response: null, error: 'timed out' })
      }, timeoutMs)
      l.waiters.set(requestId, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      this.write(l, { type: 'control_request', request_id: requestId, request })
    })
  }

  // ---- the public surface -------------------------------------------------
  /**
   * Send a turn.
   *
   * String content and block-array content are different mechanisms: with
   * `content` as a string the *CLI* expands a leading slash command, while in a
   * block array — which any inline attachment forces — expansion never happens
   * and the model just sees the text. That works for skills, wastes a turn for a
   * local command and *silently fails* for `/clear`. The fix is a split-send: a
   * `shouldQuery: false` message carrying the blocks (no turn, no cost), then the
   * command as a plain string.
   */
  async send(sessionId: string, text: string, attachments: ChatAttachment[]): Promise<boolean> {
    const l = this.live.get(sessionId)
    if (!l?.proc) return false

    const paths = attachments.filter((a) => a.kind === 'path')
    const inline = attachments.filter((a) => a.kind !== 'path')
    // Path chips need no split — they are text, and they land in $ARGUMENTS,
    // which is arguably what you meant by attaching them to a command.
    const trailer = paths.length
      ? `\n\n${ATTACH_OPEN}\n${paths.map((p) => (p.kind === 'path' ? p.containerPath : '')).join('\n')}\n${ATTACH_CLOSE}`
      : ''
    const prose = `${text}${trailer}`
    const isCommand = text.trimStart().startsWith('/')

    l.turn += 1
    l.malformed = 0
    l.mapper = null
    l.turnRunning = true
    l.interrupted = false
    l.streaming = null
    // Everything the CLI writes from here belongs to this turn, and the settle
    // re-reads from exactly here.
    l.turnOffset = l.offset

    if (inline.length > 0) {
      const blocks = inline.map((a) => inlineBlock(a))
      if (isCommand) {
        // Blocks first with shouldQuery: false — zero-cost, no model call, and
        // the following string turn sees it.
        this.write(l, {
          type: 'user',
          message: { role: 'user', content: blocks },
          parent_tool_use_id: null,
          shouldQuery: false
        })
        this.write(l, {
          type: 'user',
          message: { role: 'user', content: prose },
          parent_tool_use_id: null
        })
      } else {
        this.write(l, {
          type: 'user',
          message: { role: 'user', content: [...blocks, { type: 'text', text: prose }] },
          parent_tool_use_id: null
        })
      }
    } else {
      this.write(l, {
        type: 'user',
        message: { role: 'user', content: prose },
        parent_tool_use_id: null
      })
    }

    // Paint the turn optimistically: the row the user just wrote, and the clock.
    const at = Date.now()
    this.appendEntries(l, [
      {
        id: `you:${l.turn}`,
        role: 'you',
        at,
        turn: l.turn,
        kind: 'text',
        md: text,
        chips: attachments.length ? attachments.map(chipOf) : undefined
      },
      { id: `clock:${l.turn}`, role: 'run', at, turn: l.turn, kind: 'turn', startedAt: at }
    ])
    // main knows exactly when it wrote a user message into the process, where the
    // hook only ever knew that a prompt was submitted.
    this.setActivity(l, 'working', false, true)
    this.armSilence(l)
    return true
  }

  /**
   * Acked in under 100 ms, and the process stays alive: the next turn works and
   * the agent even knows what it was doing. Never confirmed first — the context
   * is intact, nothing rolls back, and a modal that appears *while text is
   * streaming* is the worst possible moment for one.
   */
  async interrupt(sessionId: string): Promise<void> {
    const l = this.live.get(sessionId)
    if (!l?.proc) return
    // Esc keeps one meaning in every state: stop this turn. A card is a *mid-turn*
    // state (the turn ends at `result`, not at the card), so an outstanding one is
    // answered first and then the turn is cut — the defensive order, and the one
    // confirmed on the host: the interrupt acked `success`, the turn ended
    // `aborted_streaming`, the process survived and the next turn returned
    // normally. `deny` alone never ends anything, since the agent re-calls
    // ExitPlanMode within the same turn.
    for (const [requestId] of l.pending) {
      this.respond(l, requestId, { behavior: 'deny', message: 'Interrupted by the user.' })
    }
    l.interrupted = true
    if (!l.turnRunning) return // a no-op with nothing running, and never a draft-killer
    await this.request(l, { subtype: 'interrupt' }, 5_000)
  }

  async answer(sessionId: string, requestId: string, answer: ChatAnswer): Promise<void> {
    const l = this.live.get(sessionId)
    if (!l) return
    const input = this.inputs.get(requestId) ?? {}

    if (answer.behavior === 'plan-approve') {
      // Approving a plan does not by itself leave plan mode; the host chooses the
      // next mode, and with two modes there is nothing else approval could mean.
      // The header toggle visibly moves to bypass, and setMode genuinely takes.
      this.respond(l, requestId, {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }
        ]
      })
      l.session = { ...l.session, mode: 'bypassPermissions' }
      this.emit({ kind: 'meta', sessionId, mode: 'bypassPermissions' })
    } else if (answer.behavior === 'plan-deny') {
      // A plain deny. The agent takes the note and re-calls ExitPlanMode within
      // the same turn; there is no PostToolUse asymmetry here, because *we* write
      // the response that ends the wait — approve and deny are one line of our own
      // code either way, and the TerminalView Esc/Enter heuristics have no
      // equivalent and must not be reproduced.
      this.respond(l, requestId, { behavior: 'deny', message: answer.message })
    } else if (answer.behavior === 'question') {
      // `allow` alone is NOT an answer: it yields the tool_result "The user did
      // not answer the questions." with no error raised anywhere. The choice
      // travels in updatedInput as an `answers` map keyed by question *text*.
      this.respond(l, requestId, {
        behavior: 'allow',
        updatedInput: { ...input, answers: answer.answers }
      })
    } else if (answer.behavior === 'allow') {
      this.respond(l, requestId, { behavior: 'allow', updatedInput: input })
    } else if (answer.behavior === 'deny') {
      this.respond(l, requestId, { behavior: 'deny', message: answer.message ?? 'Denied.' })
    } else {
      this.respond(l, requestId, { behavior: 'cancelled' })
    }

    // Answering ends the wait; the turn is running again unless it was the last
    // thing in it, in which case `result` will say so a moment later.
    if (l.pending.size === 0 && l.turnRunning) this.setActivity(l, 'working')
  }

  private respond(l: Live, requestId: string, result: Json): void {
    if (!l.pending.has(requestId)) return
    l.pending.delete(requestId)
    this.inputs.delete(requestId)
    this.write(l, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: result }
    })
    this.emit({ kind: 'blocking-cleared', sessionId: l.session.id, requestId })
  }

  /** Accepted mid-conversation and even mid-turn, which is what makes it a toggle. */
  async setMode(sessionId: string, mode: ChatMode): Promise<void> {
    const l = this.live.get(sessionId)
    if (!l) return
    l.session = { ...l.session, mode }
    await this.request(l, { subtype: 'set_permission_mode', mode })
  }

  async setModel(sessionId: string, model: string): Promise<boolean> {
    const l = this.live.get(sessionId)
    if (!l) return true // persisted anyway; it applies as --model at the next spawn
    const r = await this.request(l, { subtype: 'set_model', model })
    if (r.ok) l.model = model
    return r.ok
  }

  /**
   * The picker's list, lazily. No round trip until the menu is actually used.
   *
   * Observed on 2.1.211: `{models: [{value, resolvedModel, displayName, …}]}`.
   * `value` is the alias the CLI accepts back (`default` / `sonnet` / `opus` /
   * `haiku` / a pinned id) — `resolvedModel` is what it resolves *to* and would
   * not round-trip, so it stays a subtitle. Showing `value` as the label is what
   * made the menu read as a list of four generic aliases with no sign of which
   * generation they point at.
   */
  async listModels(sessionId: string): Promise<ChatModelOption[]> {
    if (this.models) return this.models
    const l = this.live.get(sessionId) ?? [...this.live.values()][0]
    if (!l) return FALLBACK_MODELS
    const r = await this.request(l, { subtype: 'list_models' })
    const options: ChatModelOption[] = []
    for (const m of arr(r.response?.models)) {
      const o = obj(m)
      if (!o) {
        const v = str(m)
        if (v) options.push({ value: v, label: v })
        continue
      }
      const value = str(o.value) || str(o.model) || str(o.id)
      if (!value) continue
      const label = str(o.displayName) || str(o.display_name) || str(o.name) || value
      const resolved = str(o.resolvedModel) || str(o.resolved_model)
      options.push({
        value,
        label,
        detail: resolved && resolved !== label ? resolved : value !== label ? value : undefined
      })
    }
    // Cached only when the CLI actually answered. The fallback is a guess and
    // must never become the app's idea of what exists — the next open asks again.
    if (options.length) this.models = options
    return options.length ? options : FALLBACK_MODELS
  }

  /**
   * At open, and at every result. A documented method with a *cosmetic* blast
   * radius — a blank meter loses a bar, where a blank activity state would break
   * the sidebar "?", the taskbar badge and the turn clock — which is why this one
   * is ridden and the env-gated session-state event is not.
   */
  private async refreshContext(l: Live, usage?: Json | null): Promise<void> {
    const r = await this.request(l, { subtype: 'get_context_usage' }, 10_000)
    let next: ChatContextUsage | null = null
    const res = r.ok ? r.response : null
    const pct = num(res?.percentage)
    const total = num(res?.totalTokens)
    const max = num(res?.maxTokens)
    if (pct !== null) {
      next = { percentage: pct, totalTokens: total ?? 0, maxTokens: max ?? 0 }
    } else if (usage) {
      // Approximate rather than absent.
      const used =
        (num(usage.input_tokens) ?? 0) +
        (num(usage.cache_read_input_tokens) ?? 0) +
        (num(usage.cache_creation_input_tokens) ?? 0)
      const cap = 200_000
      next = {
        percentage: Math.min(100, Math.round((used / cap) * 100)),
        totalTokens: used,
        maxTokens: cap,
        approximate: true
      }
    }
    l.context = next
    this.emit({ kind: 'context', sessionId: l.session.id, context: next })
  }

  // ---- fetch-on-demand ----------------------------------------------------
  body(sessionId: string, entryId: string): string | null {
    return this.live.get(sessionId)?.bodies.get(entryId) ?? null
  }

  earlier(sessionId: string, mounted: number): { entries: ChatEntry[]; total: number } {
    const l = this.live.get(sessionId)
    if (!l) return { entries: [], total: 0 }
    const end = Math.max(0, l.entries.length - mounted)
    const start = Math.max(0, end - MOUNT_WINDOW)
    return { entries: this.wireEntries(l.entries.slice(start, end)), total: l.entries.length }
  }

  /**
   * A subagent's sub-log. Live, it is the buffer the stream filled; settled, it
   * is the sibling file — read on demand, keyed by the agentId the parent's own
   * tool result reported. Reading the file for the *live* view was rejected: it
   * needs a docker exec per expand and per poll, and that round trip is precisely
   * what the open gate exists to meter.
   */
  async subagent(sessionId: string, toolUseId: string, agentId: string | null): Promise<ChatEntry[]> {
    const l = this.live.get(sessionId)
    if (!l) return []
    const buffered = l.subagents.get(toolUseId)
    if (buffered?.length) return buffered
    const uuid = l.session.claudeSessionId
    if (!uuid || !agentId) return []
    const raw = await this.docker.readSubagentLog(l.project, uuid, agentId)
    if (!raw) return []
    // The sub-log mapper KEEPS isSidechain lines — every line in a subagent file
    // carries it, and dropping them (right for the main mapper) would empty this.
    const mapper = new ChatMapper(0)
    const { lines } = parseNdjson(raw)
    const now = Date.now()
    for (const line of lines) mapper.feed({ ...line, isSidechain: false }, now)
    l.subagents.set(toolUseId, mapper.entries)
    return mapper.entries
  }

  // ---- helpers ------------------------------------------------------------
  private appendEntries(l: Live, entries: ChatEntry[]): void {
    l.entries.push(...entries)
    this.emit({
      kind: 'entries-appended',
      sessionId: l.session.id,
      entries: this.wireEntries(entries)
    })
  }

  private upsert(l: Live, entries: ChatEntry[]): void {
    for (const e of entries) {
      const i = l.entries.findIndex((x) => x.id === e.id)
      if (i >= 0) l.entries[i] = e
      else l.entries.push(e)
    }
    this.emit({
      kind: 'entries-appended',
      sessionId: l.session.id,
      entries: this.wireEntries(entries)
    })
  }

  /**
   * The live `working · 4m` row is *replaced by* the stop row rather than frozen:
   * an interrupted or crashed turn has nothing to freeze to. No event is needed —
   * the renderer drops a turn's clock row when a `stop` row for that turn lands,
   * which is the same rule stated from the other side.
   */
  private dropTurnClock(l: Live): void {
    const i = l.entries.findIndex((e) => e.turn === l.turn && e.kind === 'turn')
    if (i >= 0) l.entries.splice(i, 1)
  }

  /**
   * At `result` the row adopts Claude Code's own measured duration, so a turn
   * reads identically whether you watched it happen or reopened the session a
   * week later. This looks like it violates the host-clock invariant and does
   * not: that rule governs *timestamps* subtracted across two clocks, and this
   * number is pre-computed inside the container and never subtracted from
   * anything. The cost is a visible jump when the two clocks disagree — in
   * practice, a turn that spanned a host sleep.
   */
  private freezeTurnClock(l: Live, durationMs: number | null): void {
    const entry = l.entries.find((e) => e.turn === l.turn && e.kind === 'turn')
    if (!entry || entry.kind !== 'turn') return
    entry.durationMs = durationMs ?? Date.now() - entry.startedAt
    this.upsert(l, [entry])
  }

  private setActivity(
    l: Live,
    activity: AgentActivityEvent['activity'],
    quiet = false,
    turnStart = false
  ): void {
    const e: AgentActivityEvent = { sessionId: l.session.id, activity, at: Date.now() }
    if (turnStart) e.turnStart = true
    if (quiet) e.quiet = true
    this.emitActivity(e)
  }
}

/**
 * An inline attachment as a native content block. A native `image` block works
 * over this transport with no file, no mount and no path, and it lands in the
 * transcript inline as base64 — so it survives --resume and history replay.
 * Images pass through verbatim, no downscale and no size cap: the cap protects
 * the *context window*, not the disk, and an image costs ~1600 tokens whatever
 * the file weighs, while a 3 MB log inlined is ~750k tokens and breaks the turn.
 */
function inlineBlock(a: ChatAttachment): Json {
  if (a.kind === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
  }
  if (a.kind === 'document') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: a.mediaType, data: a.data },
      title: a.name
    }
  }
  if (a.kind === 'text') {
    return { type: 'text', text: `<file name="${a.name}">\n${a.text}\n</file>` }
  }
  return { type: 'text', text: '' }
}

function chipOf(a: ChatAttachment): { kind: 'path' | 'image' | 'document' | 'text'; name: string; detail?: string } {
  return a.kind === 'path'
    ? { kind: 'path', name: a.name, detail: a.containerPath }
    : { kind: a.kind, name: a.name }
}
