# CLAUDE.md

Vivarium is a **Windows-only Electron desktop app**: a session manager that runs Claude Code
agents in per-project Docker containers with selective folder mounts, plus container-bash and
host-PowerShell terminals. Agents come in two kinds — a terminal `agent` (xterm + the TUI) and a
`chat`, a custom chat surface driving the same CLI over stream-json. Personal corporate tool — no
external users.

## Architecture

electron-vite with three build targets (aliases `@shared`, `@renderer`):

- `src/main/` — Electron main process.
  - `ipc.ts` — `registerIpc()`: every IPC handler, the output-folder watcher, the taskbar badge.
  - `docker.ts` — `DockerService`: container lifecycle, `docker run` arg construction, image
    builds streamed line-by-line into the session terminal, plus the volume inventory behind
    the Volumes dialog (`listVolumes` / `removeVolume`).
  - `dockerfiles.ts` — inline slim/full Dockerfiles, `IMAGE_VERSION`, shared volume names.
  - `pty.ts` — `PtyManager`: node-pty processes keyed by session id.
  - `chat.ts` — `ChatService`: one live `claude -p --input-format stream-json` process per `chat`
    session (same shape as `PtyManager`), plus the transcript reader and its byte offset, the
    full-body cache, the todo fold and the subagent buffer. `chatMapper.ts` is the one mapper
    turning Claude Code's JSON — stream frames *and* transcript lines — into log rows.
  - `bridge.ts` — the agent hook bridge: per-project host dir (bind-mounted at `/vivarium`)
    holding Claude Code hook settings + `hook.sh`; `BridgeWatcher` tails its `events.log`.
  - `config.ts` — atomic persistence of the single `%APPDATA%/vivarium/config.json`.
  - `git.ts` — branch detection (reads `.git/HEAD` directly) + "Write branch diff" →
    `<sharedOutputFolder>/changes.txt`.
  - `clipboard.ts` — Ctrl+V image paste → PNG in the project clip dir (mounted at `/clip`).
  - `claude.ts` — `ClaudeService`: npm-registry `latest` lookup (10-min cache) + per-container
    installed-version probe, behind the manual Claude Code update UI.
- `src/preload/index.ts` — the typed `window.vivarium` API. The renderer never touches
  `ipcRenderer` directly.
- `src/shared/` — `ipc.ts` (channel names, `CH`), `types.ts` (all cross-process types) and
  `models.ts`. That third file is the only *logic* in `@shared` and it earns it: **both processes
  name models** — the renderer for the header chip, the composer status line and the picker,
  `chatMapper` for the `model · a → b` divider it writes into the log — so a second copy of the
  rule would let two surfaces disagree about what is answering you. `modelName` reads the dashes
  of an id as a decimal point (`claude-sonnet-4-5-…` → `Sonnet 4.5`, and the older
  `claude-3-5-sonnet-…` → `Sonnet 3.5`, since the digits sit on the other side there) and returns
  anything with no family word in it **unchanged** — inventing a name for a model this app has
  never heard of is how a chip ends up lying. `modelOptionLabel` overrides the CLI's own label
  only when it is a bare family word: `list_models` answers `Opus` / `Sonnet` (family named,
  generation hidden — the one thing the menu exists to choose between), but `Default
  (recommended)` is not a model name and must never be rewritten to whatever it resolves to today.
- `src/renderer/src/` — React + zustand + xterm. `state/store.ts` is the single store for all
  UI state. `TerminalHost` keeps one long-lived `TerminalView` per opened session — hidden on
  deselect, never destroyed, so scrollback survives switching. `theme.ts` owns the palette *and*
  `SESSION_TYPES` — the one place session-type wording, hue and popover geometry are defined; the
  picker, sidebar, terminal header and empty state all read from it, and `TypeIcon` gives each type
  its own silhouette so they never depend on color alone (four of them now: the star, the speech
  bubble, the window frame, the cube). `theme.ts` also owns `CHAT` — **the chat window's own
  palette and metrics, deliberately not the app's slate one.** The chat is built to
  `docs/redisign/Chat Terminal.html` and runs near-black and cooler than everything around it, the
  way the terminal pane already does; it is a plain object rather than CSS custom properties
  precisely so it cannot leak into the sidebar, the title bar or the terminals. Its two role hues
  (`you` coral, `claude` cyan) are load-bearing — telling a user turn, an assistant turn and a tool
  call apart is what the redesign is *for*, and the one grey mono line each that preceded it is
  what made the log unreadable. `CHAT.live` is a green and that is allowed where a mode chip's
  green would not be: it marks the CLI process being up, which is the same fact the app's
  running-indicator green already means. The ban is on a colour meaning two things, not on it
  meaning one thing twice. `components/chat/` is the chat window: `ChatView` (chrome, the reading
  column, the pinned bands, the composer), `ChatLog` (the two-column message grid),
  `Markdown`, `attach` (routing an attachment by reachability).
  `Markdown` is a **hand-rolled parser with no dependency, and it stays that way for one reason**:
  everything renders as text nodes and nothing is ever set as HTML, so a tool result containing
  markup is shown rather than run, and there is no sanitiser to get wrong. It covers what a
  conversation actually contains — nested lists (by indentation, recursing back through the block
  parser, which is the line that stops a sub-bullet being folded into the sentence above it), task
  items, tables, blockquotes, fenced and indented code, rules, and the inline set including links.
  Two rules are load-bearing and were both bugs first: an emphasis run closes only on a run of the
  **same length** (in `*a **b** c*` the inner pair is length 2 against an opening 1, so it is
  stepped over rather than closing the italics early), and a lazy list continuation stops at
  anything that starts a block, or `## Next` under a bullet joins the bullet. Links go out through
  `openExternal`, never an `<a>`: this window has no new-window handler, so a navigation would open
  the page *inside* the app.
  `Elapsed.tsx` is the only thing in the UI
  that ticks: it re-renders three characters of duration instead of its host row, on an interval
  that follows the granularity on screen (1s while showing seconds, 15s once only minutes can
  change), and its `until` prop draws a *stopped* clock — the reading holds, no interval at all.

**Adding an IPC feature** touches four places in order: channel name in `src/shared/ipc.ts` →
handler in `src/main/ipc.ts` → typed method in `src/preload/index.ts` → renderer call via
`window.vivarium.*` (usually from a store action). No exceptions for chat — its ten outbound
channels each follow this path.

**`chat:event` is the one deliberate departure** from one-channel-per-payload: it carries a
discriminated `ChatEvent` union. `ptyData`/`ptyExit` can be separate channels safely because exit
is terminal and data is opaque bytes; chat's inbound is neither. A turn emits appended entries,
then the turn-end *replacement* of those same entries, plus blocking cards, task/todo, reset and
exit — and these are strictly ordered. Electron guarantees ordering **within** a channel, not
across channels, so splitting them lets a blocking card overtake the text it refers to and render
a question above the sentence asking it. The alternative is a sequence number and a reorder buffer
in the renderer: the same guarantee bought back at a higher price.

## Invariants — do not break

- The docker logic was ported from `claude-box.ps1` (since removed from the repo — see git
  history if needed). The `(ref 123-456)` comments in `docker.ts` point at line numbers in that
  original script.
- Quitting the app **never stops containers** — only each project's explicit stop control does.
  App quit only kills local pty processes (`PtyManager.killAll`).
- **No multiplexer by design** (tmux was deliberately removed), and no detached process. **A live
  turn dies with the app** for both agent kinds — accepted model, don't add tmux/reattach logic.
  What *does* survive is narrower than "nothing": a `chat` session recovers its whole conversation
  across a restart for free, because chat and pty write the same container-side transcript and the
  chat's log is read from it rather than kept in the app. A terminal `agent` recovers the same
  conversation the same way, via `claude --resume` redrawing it. Only the in-flight turn is lost.
- Bind mounts use `--mount`, never `-v`: a Windows source path's drive-letter colon breaks the
  `-v` parser.
- Bump `IMAGE_VERSION` in `dockerfiles.ts` whenever either Dockerfile string changes — it is
  written as an image label and checked before every container start; without the bump stale
  images are silently reused.
- Volume names `claude-box-creds` / `claude-box-home` are shared with the user's existing
  claude-box setup on purpose (Claude auth/settings carry over) — never rename.
- `publishedPort` applies to `full`-image projects only; slim never publishes, even if set.
- Runtime state (container running, live ptys) is **queried live, never persisted**.
  `config.json` holds only projects/mounts/sessions/settings; writes go through
  `ConfigStore.mutate` (atomic temp-file + rename).
  **Three deliberate exceptions, all for the same reason** — these are per-session *user
  preferences*, or facts that cannot be queried live, not runtime state observed from Docker:
  `Session.mode` and `Session.model` (how a chat's agent runs; restored at spawn as
  `--permission-mode` / `--model`), and `Session.previousClaudeSessionIds` +
  `Config.pendingTranscriptDeletes` — which are not really an exception at all, since a deletion
  you owe is exactly a fact that cannot be queried, Docker being down being *why* you owe it.
  Deliberately **not** persisted, for contrast: the `list_models` result (global to the account,
  cached in main for the app run) and the composer draft + pending chips. `Project.slashCommands`
  *is* cached, on a different argument — it is a **hint, never authority**: the CLI always decides,
  so a stale entry can only mis-suggest, never mis-execute.
- Mounts may only change while the container is stopped (`ipc.ts` enforces it); saving settings
  on a running container recreates it.
- **All terminal resizing goes through `fitNow()`** in `TerminalView` — never call `fit.fit()` or
  `resizeSession` directly. FitAddon clamps a collapsed container to 2×1 instead of refusing, and
  a 2-column fit reflows the whole 50k-line scrollback irrecoverably. (Chat sessions have no
  terminal and no fit — `ChatView` sits *beside* the terminal views in `TerminalHost`, never in
  place of them, because those views are what hold the ptys.) `fitNow` also only messages
  the pty when the size really changed (a resize per fit meant a SIGWINCH storm on zoom) and
  re-syncs the scrollbar, whose geometry xterm only recomputes inside a `requestAnimationFrame` —
  frames a minimized/occluded window never gets, which is what left agent terminals unable to
  scroll back. Same file: in the **normal** buffer the mouse wheel belongs to the user even when
  the app has enabled mouse tracking (Claude Code does), only the **alternate** buffer gets it.
- **A stale scroll area is "short of the buffer", not "zero range".** `repairIfStuck` compares what
  the DOM bar can reach against `baseY` rows of history, because a bar that stopped following the
  buffer is not only ever one screen tall — shrink the window and it reappears reaching exactly as
  far as the taller window had shown, which the old zero-range test scored as healthy. Row height
  is measured off `.xterm-screen`, never taken from xterm: the viewport caches the *renderer's*
  dimensions object by reference, and a renderer swap at an unchanged size (WebGL context loss →
  DOM fallback) fires no onDimensionsChange, leaving it sizing the bar from a dead one.
- **`TerminalHost` keeps one long-lived view per opened session — terminals *must*, chat *may*.**
  Unmounting a terminal disposes its xterm and 50k-line scrollback irrecoverably; nothing in a chat
  is unrecoverable, because main holds the log and re-reads the transcript incrementally at every
  turn end, so a remount re-hydrates over IPC from a cache that is already current and never
  touches docker. `toRender` therefore gains **no chat arm** — the `live[]` clause is kept for
  chat too, for *cheapness rather than survival*, and that reason belongs in the comment so nobody
  later "fixes" it by adding a type branch.
- **A terminal's lifetime follows its pty, not the container probe.** `TerminalHost`'s `toRender`
  filter decides which sessions have an xterm at all, and its third clause (`live[session.id]`)
  must never be dropped: unmounting disposes the xterm and the 50k-line scrollback with it, and
  `states[].running` is a 3s `docker inspect` poll whose `isRunning` reports false for any non-zero
  exit (busy daemon, WSL hiccup, unspawnable docker.exe), so one blip used to wipe every terminal
  in a project — invisibly, since `PtyManager.spawn` re-attaches the same pty on the remount and
  the agent never notices. The same filter must not open a session on a *genuinely* stopped
  container either; starting one stays an explicit user action (`ipc.ts` openSession refuses).
- **A session is live whenever it can be, not when it was last clicked.** `toRender` is derived —
  host shells (no container needed) from app launch, everything else as soon as its container is
  running, whether that is an explicit start or a container already up at launch. Two consequences
  the code depends on: the terminal body renders even with nothing selected (`EmptyState` is an
  overlay *inside* it), because the views in there are what open the ptys; and `openSession` is
  retried on `container-stopped`/`spawn-failed` while the store still says running, because a
  project's sessions now all open at once and that burst is what makes `docker inspect` answer
  non-zero. `OPEN_LIMIT` in `ipc.ts` caps the burst for the same reason — it hands slots straight
  to waiters rather than releasing the count, or the cap drifts up by one per handover.
- **Moving a session between projects transfers the conversation for free — and only that.**
  `claudeSessionId` lives on the `Session` object, `/home/node/.claude` is the same
  `claude-box-creds` volume in every container, and agents always exec with `-w /workspace`, so the
  transcript path is identical from any container and `execArgs` picks `--resume` itself. No
  `.jsonl` is copied and no store map re-keyed (they all key on session id). What does *not* follow:
  the pty (a `docker exec` client bound to the old container), the scrollback, and the mounts —
  `/workspace` is the target project's now, which is the point.
  `moveSession` kills the pty **silently** because it kills before rewriting config, so the exit
  would otherwise land on the replacement terminal; `TerminalHost` keys views on
  `project.id:session.id` so that replacement actually happens.
- **Claude Code is never auto-updated.** It used to be — a fire-and-forget `npm i -g` on every
  container start — which invisibly changed the CLI version under a live session. Updates are now
  user-initiated only: title-bar version chip / project context menu → the Claude Code dialog, which
  runs `sudo npm install -g …@latest` in one running container at a time. Consequences the UI states
  rather than hides: the CLI only exists inside containers (a stopped one has no version to read), a
  running `claude` keeps its version until relaunched, and since the install lands in the writable
  layer a `recreate` reverts it to the image's version — the chip re-flags it instead of silently
  self-healing.
- **A turn duration is a stopwatch on the host clock, and blocking on the user pauses it.**
  `hook.sh` writes a container-side timestamp into `events.log` and `bridge.ts` ignores it: events
  are stamped with `Date.now()` as the host *reads* the line (`AgentHookEvent.at`), because a WSL2
  clock drifts from Windows across host sleep and these values are subtracted from the renderer's
  clock to show "working 4m" — a skewed one would print a negative or absurd turn (the log's own
  timestamp is for post-mortem reading only). `agentSince` is stamped on real transitions only, so
  a pty exit reporting idle for an already-idle agent can't claim its turn just ended;
  `UserPromptSubmit` re-stamps unconditionally, since a queued prompt starts a new turn while the
  state is already `working`. The third state, `waiting` — a question asked, or a plan up for
  approval — is mid-turn (the turn ends at `Stop`) but nothing is running, so `agentWaitingSince`
  freezes the reading at `agentWaitingSince - agentSince` and resuming pushes `agentSince` forward
  by the whole wait: the number always means work done, not wall time. Everything reads that state
  rather than inventing its own — the sidebar row and the collapsed project row show "?" (not from
  the notification: a waiting agent you happen to be watching is still waiting), the terminal
  header says `waiting`.
- **Volumes are only ever removed from the Volumes dialog.** Nothing else in the app removes
  one — deleting a project drops its container, not the shadow build caches its mounts created
  (`shadowMounts`), which are keyed by a hash of the *host path* and so are stranded by a
  rename or an unmount. `SHADOW_KINDS` is shared between the run-arg builder and the
  classifier so the names can't drift. `claude-box-creds`/`claude-box-home` are reported but
  never removable (the Claude sign-in and every agent's memory live there) — the guard is in
  `DockerService.removeVolume` as well as the UI, because the name arrives over IPC. Sizes come
  from `docker system df -v`, the only command that reports them; it walks every volume
  directory, so the dialog shows a loading state and the renderer drops a removed row instead
  of re-sweeping.
- **No "Clear" in the terminal context menu.** xterm's `clear()` drops the entire 50k-line
  scrollback, which made it the one irreversible item in a menu of harmless ones, two rows
  under Paste and with no confirmation. The shell's own `clear`/`cls` covers the intent.
- **The focus ring is a `box-shadow`, not an `outline`** (`GLOBAL_CSS`). Every field in this app
  sets `outline:none` *inline* and inline styles win, so an outline rule would silently do
  nothing on exactly the controls that need it. It is `:focus-visible`, so pointer input never
  lights it up; the find bar's input opts out with an inline `boxShadow:'none'` because it is
  focused for as long as the bar exists.
- Agent idle/working detection and the attention-notification have **two producers that unify at
  the event, not at the channel.** Both emit `AgentActivityEvent` on `agent:activity`, and the
  store cannot tell them apart — which is the point. Do not reintroduce hook *kinds* over IPC: an
  adapter emitting the old `AgentHookEvent` shape was the earlier design and it does not work in
  this direction, since main would have to emit `'ExitPlanMode'` to mean "waiting" and a chat's
  working-directory permission prompt has no hook kind to lie with at all.
  - **pty `agent` sessions: Claude Code hooks**, exactly as before (`UserPromptSubmit`/`Stop`, plus
    `PreToolUse` matchers on the two tools whose execution *is* a wait — `AskUserQuestion` and
    `ExitPlanMode` — and their `PostToolUse`, which is the answer landing), never by parsing
    terminal output. Agents launch with `--settings /vivarium/hooks.json` +
    `-e VIVARIUM_SESSION_ID=<id>`; the hook script appends to `/vivarium/events.log`, which the
    main process tails (`bridge.ts`), and **`bridge.ts` now owns the hook→state mapping** so that
    vocabulary stops at the process boundary. Never scope the hooks via the shared
    `/home/node/.claude/settings.json` — that would leak them into claude-box sessions.
  - **`chat` sessions: derived from the ordinary stream**, which costs no extra parsing because
    main is already reading every message to render the log — `assistant` → working, *any* pending
    `can_use_tool` → waiting, `result` → idle. A chat is **never** pointed at
    `/vivarium/hooks.json` and never gets a `VIVARIUM_SESSION_ID`: double-emitting would give the
    store two producers for one session. `system/session_state_changed` is deliberately **not**
    used and `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is never set, even though it exists and is a
    1:1 match — an undocumented env-gated signal in a CLI this app has the user update by hand is
    the silent breakage hooks were introduced to end. That reading is also strictly *more* correct
    than the pty's: bypass does not dissolve the working-directory guard, so an out-of-mounts read
    still blocks the turn on a human, and the hook bridge cannot see that case at all.
  - Hook gotchas, **now scoped to pty agents only**: `Stop` does not fire on a user esc-interrupt
    (the renderer resets the indicator on Esc); `PostToolUse` does not fire when a call is
    *rejected*, and "No, keep planning" is exactly that, so `TerminalView` also resumes on the
    Enter that answers a prompt (a no-op in every state but `waiting`). Both are TUI artifacts and
    **neither exists over stream-json** — "keep planning" arrives as a plain `deny` observed
    identically to approve, and an interrupt reports cleanly as `aborted_streaming` /
    `aborted_tools`. `TerminalView.tsx`'s Esc/Enter heuristics must not be reproduced in the chat.
  - Still true for both: bridge files are rewritten and the log truncated on every container start,
    so a container that was already up serves the old `hooks.json` to newly launched agents until
    it is restarted; and `start()` auto-recreates containers that lack the `/vivarium` mount.
- **A chat session drives Claude Code; it is not a bespoke agent loop.** One live
  `docker exec -i … claude -p --input-format stream-json --output-format stream-json` process per
  session — **`-i`, never `-it`**, no TTY anywhere in the path. Three flags are load-bearing:
  `--permission-prompt-tool stdio` is a *sentinel, not a real MCP server*, it is undocumented and
  absent from `claude --help`, and without it a raw `-p` run **auto-denies every prompt** *and*
  drops `AskUserQuestion`/`ExitPlanMode` from the tool list entirely; `--forward-subagent-text`
  is what makes the live sub-log match the settled sibling file block for block;
  `--include-partial-messages` gives the token deltas the log paints from. **Nothing is emitted
  until the first user message is written** — `system/init` is the answer to turn one, not a
  greeting, so a client that waits for it deadlocks. The *control* channel is a separate matter and
  is live from spawn, which is what makes the open-time context reading possible.
- **The transcript is the chat's model, not a log of it.** History comes from the container-side
  `/home/node/.claude/projects/-workspace/<uuid>.jsonl`, read with `docker exec`; there is **no
  host-side mirror**, because a mirror only knows turns the app streamed and can drift from the
  file `--resume` actually feeds the model. While a turn runs the log paints from the stream
  (provisional); at `result` main re-reads the bytes appended since its stored **byte offset** and
  *replaces that turn's rows* with transcript-derived ones — so anything more than a few seconds
  old is always the same bytes a restart would render, and a mapper disagreement shows up as a
  visible twitch at turn end during development rather than as a bug report weeks later. Accepted
  cost: **no history while the container is stopped**, which lands on the `StoppedPlaceholder` that
  already explains why.
  **Three rules make that replacement safe, and all three exist because it deletes what it
  replaces.** (1) *Whole lines only* — a read of a file the CLI is still appending to lands mid-line
  routinely, and advancing the offset past the fragment loses that whole message forever, so
  `completeLines` consumes up to the last newline and lets the boundary re-read itself. (2) *One
  turn per settle* — `takeTurn` stops at Claude Code's own `system/turn_duration` line, because a
  queued follow-up is already in the file by the time `result` sends us off to read, and mapping it
  under the turn above it shows that message twice. The boundary is that marker rather than a guess
  at what a user line looks like: an interrupt marker, a command echo and its
  `<local-command-stdout>` reply are all plain user text lines *inside* a turn. (3) *A settle reads
  from the turn's own start offset*, which makes settling twice idempotent — that is what lets a
  late flush be recovered by simply doing it again, once, on the evidence that the settled turn
  holds less prose than the stream already painted. An **aborted** turn is not settled but its
  bytes are still stepped over (`skipTurn`), or the next turn would map them again.
- **`isSidechain` is never filtered on in the chat mapper.** A transcript written by `claude -p`
  marks **every** line `isSidechain: true`, main conversation included — the exact inverse of a
  TUI-written transcript, where every line is `false` (verified on 2.1.211). Dropping those lines
  blanks the entire log for exactly the sessions this feature creates. It is unnecessary anyway:
  subagent work is not written into the parent file at all, it lives in a sibling `subagents/`
  directory read on demand.
- **Chat entry ids are `<message id>#<block type>#<ordinal among blocks of that type>` — never the
  content-array index.** Claude Code writes one transcript line per content block but gives every
  line of one API message the same `message.id`, so a message whose text and tool call are two
  lines yields two blocks both at index 0: without the *type* in the key the tool card silently
  overwrites the paragraph above it. The *ordinal* is there because the index means three different
  things depending on where a block arrives — a transcript line and a per-block `assistant` frame
  each carry a one-element content array (index always 0), while `stream_event` deltas number
  blocks across the whole message. A `[thinking, text]` message therefore painted `msg#1#text` from
  deltas while its settled row was `msg#0#text`, and the paragraph rendered twice until turn end.
  Counting per type is the one derivation all three sources agree on, since blocks arrive in order
  everywhere. `chatMapper.textBlockId` is the single spelling of that rule, exported so `chat.ts`
  can compute a partial row's id without a second copy of it. Ids must stay stable across the
  stream→transcript settle, since the renderer upserts by id.
- **A slash command's own output is not something the user typed.** Claude Code records a local
  command as `<command-name>`/`<command-message>`/`<command-args>` and its result as a separate
  `<local-command-stdout>` — both on ordinary **user** lines, sometimes on the same one. The mapper
  recognises them there, not only in the `system/local_command` branch, or the raw tags render
  inside the tinted `you` bubble as though you had typed the markup. The three command tags are
  read separately because they are *not* adjacent: a pattern that required args to follow the name
  dropped every argument silently.
  **The composer's typeahead has no highlight until you ask for one, and that null is what makes
  Enter safe**: with nothing selected, Enter still sends `/clear` as the command you typed, and
  only a deliberate reach into the list (Tab, or ↑↓) turns Enter into "take this row". Tab is two
  presses — the first highlights the best match, the second inserts it — because one press cannot
  be both (completing immediately means you can never *look* at the list; highlighting only means
  Tab alone never completes). The list is deduped: `init` reports `slash_commands[]` and `skills[]`
  separately and they overlap, so the raw concatenation offers `code-review` twice and collides its
  React key. The composer tints a leading `/command` only when it is one the CLI actually has —
  the tint means "this will expand", not "this begins with a slash" — drawn by a transparent twin
  laid out behind the textarea, since a textarea holds one flat string and can carry no colour.
- **Delete means delete, for chat conversations.** Deleting a chat session deletes its conversation,
  and deleting a project cascades to every chat session it holds — otherwise the larger, more
  destructive gesture would be the leakier one. Both take the whole chain (`claudeSessionId` plus
  every id `/clear` retired). The mechanism is a **debt list** (`Config.pendingTranscriptDeletes`)
  written in the *same atomic mutate* that removes the session, then drained — not try-then-enqueue,
  which leaves a window where the session is gone and nothing records that anyone meant to delete
  its transcript. Drains at app launch and after each successful container start, the two moments
  Docker is proven up; never off the 3s container poll, which `isRunning` already documents as
  unreliable. The delete always proceeds even with Docker down, matching `deleteProject`, which
  already discards `docker.remove`'s exit code. **There is no sweep and there never will be:** the
  `-workspace` slug holds Vivarium's transcripts *and* claude-box's, identical on disk, and
  sweep-by-exclusion would silently destroy real conversations on the one volume that is never
  removable. Everything stranded before this landed stays, deliberately.
  The removal runs `docker run --rm -v claude-box-creds:… vivarium:slim sh -c 'rm -rf …'` —
  **`-v` is legitimate here** (that invariant is about a Windows drive-letter colon, and a named
  volume has none), and `docker exec` was rejected because `deleteProject` force-removes the
  container in the same handler and a stopped project has nothing to exec into. **This is `rm -rf`
  with an interpolated variable: the safety rests entirely on the uuid coming from `randomUUID()`,
  and a transcript is a *directory* (`<uuid>/subagents/…`), not a file.**
- **The chat has no terminal states, and nothing retries itself.** Every failure is recovered by the
  same single act — respawn the process and re-read the transcript — because the conversation is in
  the transcript rather than in the process. A stopped container is the only state it cannot
  recover from on its own. Detection is thinner than it looks: killing the in-container `claude`
  mid-stream is **completely silent** (no result, no error line, no torn line) and the `docker exec`
  exit code is the only signal, while a broken credential emits a normal-looking `init` and then
  nothing at all — hence a **60s silence timeout on *any* frame**, not on `result`. Recovery is
  **never automatic**, the timeout row least of all: a wedged CLI would otherwise be respawned every
  minute for as long as the app is open.
- **`terminal_reason` is the only test that distinguishes cancelled from failed.** `is_error` cannot
  — a clean deny-then-interrupt reports `is_error: true`. On reopen, where there is no
  `terminal_reason`, a cancelled tool is detected **structurally** (the error results with nothing
  after them in the turn but the interrupt marker), never by matching the refusal wording. The one
  accepted prose-parsing rule in the whole design is recovering an answered `AskUserQuestion`'s
  ticked chip, and it has a graceful fallback; keeping it to one is why the cancelled rule is
  positional.
  **The `interrupted` row itself has two producers and they are not ordered against each other.**
  Claude Code writes a synthetic `[Request interrupted by user]` user message, which the mapper
  turns into that row, and `result` carries `terminal_reason` and produces one too — both arrive on
  the same stream, and one Esc used to print two rows. Neither can be dropped: the mapper's is what
  a *reopened* conversation renders (it is the one in the transcript), and `result`'s is the only
  row a CLI that emits no such message would produce at all. So whichever lands second is
  suppressed, per turn — never by a shared fixed id, or a conversation with five interrupted turns
  would collapse to one row.
- **The context meter is only ever as fresh as the last thing that asked for it**, so changing the
  model has to ask. `get_context_usage` is polled at open (the load-bearing half: nothing is
  emitted on the wire until the first user message, so a chat reopened onto 80k of history would
  otherwise show an empty meter at exactly the moment you look at it), at every `result`, and now
  after `set_model` — the ceiling is a property of the model, and picking one used to leave a 200k
  scale reading 1M until the next turn happened to refresh it. `setModel` also adopts the
  *resolved* model for display while `Session.model` keeps the **alias**: the alias is what
  `--model` needs at the next spawn, and the resolved id is what makes the chip say `Opus 5`
  instead of `Opus`.
- **A settled turn's rows are dropped by id as well as by turn.** A transcript line can be mapped
  under one turn and then again under another: `set_model` writes a `Set model to …` line
  *between* turns, no settle has accounted for it, so the next turn's settle reads from an offset
  behind it and maps it a second time. Filtering only on `turn` keeps both copies, and two rows
  sharing an id is the one inconsistency the log cannot survive — the renderer keys on the id, and
  React answers a collision by silently dropping or duplicating a row rather than by erroring. Both
  ends filter the same two ways (`ChatService.settleTurn`, the store's `turn-settled`).
- **Streamed prose is revealed at a steady rate, and that is not decoration.** Measured against
  `--include-partial-messages` on the host: text arrives in **~68-character jumps about every
  460 ms** — nine paint steps for a 554-character paragraph — so the log lurched a line and a half
  at a time. That cadence is Claude Code's own, which is why the fix cannot live in main: the
  40 ms coalescing window there (`STREAM_FLUSH_MS`) bounds IPC and stops a burst becoming a burst
  of renders, but the source is already coarser than any window worth batching over. `ChatLog`
  drains the buffer instead, at a *rate* rather than a delay (`REVEAL_CATCHUP`), so a big chunk
  drains proportionally faster and the text on screen can never lag the model by more than one
  interval. Three constraints on it: only the row the running turn is writing into (history, a
  settle and a reopened conversation all paint whole), it starts from whatever the row held when
  it mounted so nothing ever re-types itself, and it snaps to full the instant the turn ends —
  a typewriter still running after the answer is finished is worse than no smoothing at all.
  `LogRow` is `React.memo`'d and `ChatView`'s `handlers` memoised for the same reason: without
  both, every one of those paints re-rendered every row in the log, markdown parse included.
- **The log follows the tail on a ResizeObserver, not on the entry count.** A turn streaming its
  answer *grows the last row* rather than adding one, so a `[entries.length]` effect never fired
  and the sentence being written slid off the bottom. Height is what actually moves. The observer
  watches the content **and the scroller** — a composer growing to three lines takes height away
  from the log without changing anything inside it — and `pinned` (within 40px of the bottom) is
  what keeps it from yanking a user who has scrolled up to read.
- **Chat zoom is CSS `zoom` on the two reading columns, never on the view root.** The chat is a
  whole layout — a 96px gutter, an 880px measure, cards, a composer — so scaling only the type
  would leave all of it behind at its 1× proportions. The root is `position:absolute; inset:0` and
  a zoomed box scales its own edges; the columns are plain auto-width blocks, which fill the
  scroller at any factor exactly the way browser zoom behaves. The log's column and the composer's
  carry the same factor so the two stay aligned. `chatZoom` is session-only store state, shared by
  every chat like `terminalFontSize` is shared by every terminal — you zoom because of the monitor
  you are sitting at. Ctrl +/-/0 and Ctrl+wheel, the chords `TerminalView` already binds, and the
  log's context menu is where they are written down (the terminal's menu is the precedent: a chord
  nothing on screen mentions may as well not exist).
- **An attention flag is cleared by viewing its session — and focusing the window is viewing.**
  `notifyAgentAttention` declines to flag only when the window is focused *and* that session is
  selected, so anything landing while the app is in the background flags the session you are
  sitting on too — and `select`, which acknowledges the row you click, structurally cannot clear
  that one. So main sends `windowFocused` from the same `win.on('focus')` that stops the flash, and
  `acknowledgeSelected` drops the selected session's flag, taking the taskbar overlay with it if it
  was the last. Only the selected one: the count is not a "seen the app" flag.

## Commands

```
npm install          # postinstall rebuilds node-pty against Electron
npm run dev          # electron-vite dev server + Electron
npm run typecheck    # tsc for both tsconfig.node.json and tsconfig.web.json
npm run build:win    # NSIS installer in dist/
```

## Verifying changes

There is **no test suite, by design — don't add one.** Verify with:

1. `npm run typecheck` — always.
2. **On the Windows host: drive the real app with the `playwright` MCP server** (pinned in
   `.mcp.json`, attached over CDP — it drives Electron, not a browser). Two steps, in order:
   - `npm run dev:cdp` — the ordinary dev app plus `VIVARIUM_CDP_PORT=9366` and
     `VIVARIUM_CDP_SHOW=1`. **Playwright can only attach, never launch**, so nothing works until
     this is up; start it and retry rather than reaching for `browser_navigate`.
   - Then `browser_snapshot` → `browser_click`/`browser_type`/`browser_press_key` →
     `browser_take_screenshot`. `target` takes either a snapshot ref (fresh each snapshot) or a
     plain selector, and a selector is what makes a flow re-runnable:
     `button[title="Hide sidebar"]`, `input[placeholder="my-service"]`.
   - `browser_evaluate` reaches the two debug handles the renderer exports, which is where this
     app's truth actually lives: `window.__vivStore.getState()` (zustand — dialogs, container
     states, chat entries) and `window.__vivTerms[sessionId]` (xterm, for scrollback that is on
     a canvas and in no DOM). Verify against those, not against pixels.
   Three things worth knowing before disbelieving what it shows you:
   - **Occlusion is the whole ballgame.** Windows tells Chromium when the window is fully
     covered and Chromium stops compositing it: screenshots time out, `requestAnimationFrame`
     never fires, and every dialog's entry animation freezes at opacity 0 — so the app looks
     empty and the click looks lost. `CalculateNativeWinOcclusion` is disabled under CDP for
     exactly that reason.
   - Not every chip is a button — the four session types under the empty state are a *legend*,
     with no handler. Snapshot before assuming a click did nothing.
   - **Never `browser_close`**: it closes the app, not a tab. It drives the *real* app, so it
     will start containers and spend tokens if you click the things that do that.
3. A headless smoke run of the real app inside this dev container (Linux):
   - Electron's system libs are not baked into the image; after a container recreation:
     `sudo apt-get install -y --no-install-recommends libgtk-3-0 libnss3 libasound2 libgbm1 libxss1`
   - `nohup Xvfb :93 -screen 0 1600x1000x24 &` (nohup specifically; plain `&` dies with the
     shell — verify with `DISPLAY=:93 xset q`)
   - `ELECTRON_DISABLE_SANDBOX=1 VIVARIUM_CDP_PORT=9366 DISPLAY=:93 nohup npm run dev &`
     — `VIVARIUM_CDP_PORT` keeps the window hidden and exposes CDP on that port
     (`VIVARIUM_CDP_SHOW=1` opts back into a visible window, which is what the MCP server sets:
     a hidden window is never composited, so there is no frame to screenshot).
   - Drive it with Playwright: `chromium.connectOverCDP('http://127.0.0.1:9366')`; the app page
     is the one on `localhost:5173`. `window.__vivTerms[sessionId]` exposes each session's
     xterm instance for reading scrollback.
   - Vite HMR does not fire on this bind mount — kill Electron
     (`ps aux | grep '[e]lectron/dist'`) and relaunch to pick up renderer edits.
4. Anything docker-, pwsh-, or WSL-dependent cannot run in this container — the user verifies
   those paths on the Windows host. Say so explicitly instead of claiming verification.

## Code style

- Prettier-ish: 2-space indent, single quotes, no semicolons, explicit return types on
  functions.
- **Comment policy (overrides the global no-comments rule):** this repo is deliberately
  densely commented. New code should keep that style — explain Windows quirks, docker gotchas,
  and non-obvious design decisions inline, focusing on *why* and on constraints the code can't
  express.
- Cross-process types live in `src/shared/types.ts`; renderer-only types stay in the renderer.
