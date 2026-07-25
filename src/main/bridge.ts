import { app } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentHookEvent } from '@shared/types'

// The "bridge" is how agent lifecycle events get out of the container: a small
// host dir (one per project) bind-mounted at /vivarium. Vivarium writes a
// Claude Code hooks settings file + a tiny shell script into it; the agent is
// launched with `--settings /vivarium/hooks.json`, so Claude Code itself
// reports UserPromptSubmit (turn started), Stop (turn finished) and
// AskUserQuestion (agent blocked on a question to the user) by appending
// a line to /vivarium/events.log, which the main process tails from the host
// side. This replaces the old approach of scraping the xterm buffer for the
// "esc to interrupt" spinner text, which silently broke when the Claude Code
// TUI changed. Hooks are a documented interface; the TUI is not.
//
// Scoping the hooks to `--settings` (instead of writing into the shared
// /home/node/.claude/settings.json volume) keeps claude-box.ps1 sessions and
// manually-launched `claude` runs unaffected.

/** Host-side bridge dir for a project (bind-mounted at /vivarium). */
export function bridgeDir(projectId: string): string {
  return join(app.getPath('userData'), 'bridge', projectId)
}

const EVENTS_FILE = 'events.log'

// Stop does NOT fire on a user esc-interrupt (documented behavior), so the
// renderer additionally resets the activity indicator on Esc keypresses.
const HOOKS_JSON = `${JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh UserPromptSubmit' }] }
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh Stop' }] }],
      // AskUserQuestion has no dedicated hook event; its "execution" is showing
      // the question UI, so PreToolUse fires exactly when the agent starts
      // waiting for an answer.
      PreToolUse: [
        {
          matcher: 'AskUserQuestion',
          hooks: [{ type: 'command', command: 'sh /vivarium/hook.sh AskUserQuestion' }]
        }
      ]
    }
  },
  null,
  2
)}\n`

// Invoked as `sh /vivarium/hook.sh <event>` — the file has no exec bit because
// it is written from the Windows host. Reads (and discards) the JSON payload
// Claude Code puts on stdin so the hook never dies on a broken pipe, then
// appends one TSV line. Single small O_APPEND writes don't interleave.
const HOOK_SH = [
  '#!/bin/sh',
  'cat > /dev/null',
  `printf '%s\\t%s\\t%s\\n' "$1" "\${VIVARIUM_SESSION_ID:-}" "$(date +%s)" >> /vivarium/${EVENTS_FILE}`,
  ''
].join('\n')

/**
 * (Re)write the bridge files for a project and truncate its event log. Called
 * right before a container is started or created — never while one is running —
 * so hook-script updates propagate without an image rebuild, and stale events
 * from a previous container life are dropped (the watcher handles the shrink).
 */
export async function ensureBridgeFiles(projectId: string): Promise<void> {
  const dir = bridgeDir(projectId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'hooks.json'), HOOKS_JSON, 'utf8')
  await writeFile(join(dir, 'hook.sh'), HOOK_SH, 'utf8')
  await writeFile(join(dir, EVENTS_FILE), '', 'utf8')
}

/**
 * Tails one project's events.log and emits parsed hook events. Lines written
 * before the watcher started are skipped (no replaying stale notifications
 * after an app restart while the container kept running).
 */
export class BridgeWatcher {
  private watcher: FSWatcher | null = null
  private offset = 0
  private reading = false
  private pending = false

  constructor(
    private dir: string,
    private onEvent: (e: AgentHookEvent) => void
  ) {}

  async start(): Promise<void> {
    const file = join(this.dir, EVENTS_FILE)
    await mkdir(this.dir, { recursive: true })
    try {
      this.offset = (await stat(file)).size
    } catch {
      await writeFile(file, '', 'utf8').catch(() => {})
      this.offset = 0
    }
    try {
      // Watch the dir, not the file: dir watches survive the truncate-rewrite
      // that ensureBridgeFiles does on container start.
      this.watcher = watch(this.dir, (_event, filename) => {
        if (!filename || filename === EVENTS_FILE) void this.drain()
      })
    } catch {
      this.watcher = null // dir vanished — no events until recreated
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /** Serialize reads; coalesce change-event bursts into one trailing read. */
  private async drain(): Promise<void> {
    if (this.reading) {
      this.pending = true
      return
    }
    this.reading = true
    try {
      do {
        this.pending = false
        await this.readNew()
      } while (this.pending)
    } finally {
      this.reading = false
    }
  }

  private async readNew(): Promise<void> {
    const file = join(this.dir, EVENTS_FILE)
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      return
    }
    if (size < this.offset) this.offset = 0 // truncated by ensureBridgeFiles
    if (size === this.offset) return

    const fh = await open(file, 'r')
    let chunk: Buffer
    try {
      const buf = Buffer.alloc(size - this.offset)
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
      chunk = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }

    // Only consume complete lines — a partially-flushed line stays for the
    // change event its terminating newline will trigger.
    const nl = chunk.lastIndexOf(0x0a)
    if (nl < 0) return
    this.offset += nl + 1

    // The line's third field is the container's own timestamp; it stays in the
    // log for post-mortem reading but never reaches the UI — see
    // AgentHookEvent.at for why the host stamps these instead.
    const at = Date.now()
    for (const line of chunk.subarray(0, nl).toString('utf8').split('\n')) {
      const [kind, sessionId] = line.split('\t')
      if (
        (kind === 'UserPromptSubmit' || kind === 'Stop' || kind === 'AskUserQuestion') &&
        sessionId
      ) {
        this.onEvent({ sessionId, kind, at })
      }
    }
  }
}
