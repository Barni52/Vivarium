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
  palette and metrics, held as plain strings rather than CSS custom properties precisely so they
  cannot leak into the sidebar, the title bar or the terminals.** It was near-black, read off
  `docs/redisign/Chat Terminal.html`; it is now **the agent tab's greys** — page on
  `--terminal-bg`, chrome on `--panel`, hairlines on `--border`, prose on `--terminal-text`, and a
  34px header, the same as `TerminalHost`'s to the pixel. Switching between an agent and a chat in
  one project should not feel like switching applications, and both the colour and the 18px the
  header used to jump said otherwise. Those four values are *copied*, not referenced, which is the
  price of not leaking — if that grey ever moves, `CHAT` is the second place to move it. Two tokens
  exist because the page is no longer the darkest thing on screen: `well` (a recess inside a panel)
  and `onAccent` (ink on a filled accent), both of which used to be `bg` itself. `radius` /
  `radiusCard` are the corners; the control radius is applied once, as a `.vchat`-scoped rule in
  `GLOBAL_CSS`, so it reaches buttons nobody has written yet — and **hover/press are applied the
  same way and for the same reason**, as a `filter: brightness()` rather than a background,
  because every control in this window is styled *inline* and an inline background beats any rule
  that sheet could write (the same trap the focus ring documents). Anything clickable that is not
  a `<button>` — a tool card, the thinking row, both divs because they wrap block content — opts
  in with a `data-click` attribute. `CODE` is the syntax palette, held apart from `CHAT` because it
  is read by exactly one consumer (`highlight.ts`) and because a token hue answers to a different
  rule than a chrome hue: seven of them appear at once, in a grid, at 11.5px, on the *lighter*
  `card` rather than on the page — so each is muted a step further than `ACCENT` already asks for.
  Three of its colours are deliberate near-misses of `CHAT` ones and the doc comment says which:
  a string is not `live`, a function name is not `claude`, a removed line is not `danger`, because
  each of those already means something else in this window. `CHAT_TEXT` is the window's type scale (prose, its leading,
  mono, the gutter, code) and every size in `ChatLog`/`Markdown`/the composer is that object or
  derived from it: "make the chat smaller" is one request and it must not be thirty numbers. It is
  not the zoom — zoom is the reader's knob at their own desk and multiplies all of this. The whole window is **JetBrains
  Mono**, set once on the chat root and inherited — including the composer, since
  `input,button,textarea{font-family:inherit}` is already global. Its two role hues
  (`you` coral, `claude` cyan) are load-bearing — telling a user turn, an assistant turn and a tool
  call apart is what the redesign is *for*, and the one grey mono line each that preceded it is
  what made the log unreadable. `CHAT.live` is a green and that is allowed where a mode chip's
  green would not be: it marks the CLI process being up, which is the same fact the app's
  running-indicator green already means. The ban is on a colour meaning two things, not on it
  meaning one thing twice. The window is otherwise mono throughout, with **one** exception, and
  `SANS` exists to spell it: the question overlay is a form — checkboxes, radios, prose
  descriptions — and in mono it read as terminal output that happened to be clickable.
  `components/chat/` is the chat window: `ChatView` (chrome, the log column, the pinned bands, the
  composer, the question overlay), `ChatLog` (the message list: every row is `hh:mm role` on its own
  line with the content full-width under it — it was a two-column grid with an 84px gutter, and the
  column charged every line of every message for two words that only ever sat beside the first),
  `Markdown`, `attach` (routing an attachment by reachability).
  `Markdown` is a hand-rolled parser, and the rule it is built around is **everything renders as
  text nodes and nothing is ever set as HTML** — so a tool result containing markup is shown
  rather than run, and there is no sanitiser to get wrong. That is a constraint on the *output*,
  not a ban on dependencies: `highlight.ts` uses Prism, but only `Prism.tokenize`, which returns a
  token tree, never `Prism.highlight`, which returns an HTML string. Anything reached for later
  clears the same bar or it does not go in. It covers what a
  conversation actually contains — nested lists (by indentation, recursing back through the block
  parser, which is the line that stops a sub-bullet being folded into the sentence above it), task
  items, tables, blockquotes, fenced and indented code, rules, and the inline set including links.
  Two rules are load-bearing and were both bugs first: an emphasis run closes only on a run of the
  **same length** (in `*a **b** c*` the inner pair is length 2 against an opening 1, so it is
  stepped over rather than closing the italics early), and a lazy list continuation stops at
  anything that starts a block, or `## Next` under a bullet joins the bullet. Links go out through
  `openExternal`, never an `<a>`: this window has no new-window handler, so a navigation would open
  the page *inside* the app.
  `highlight.ts` is the syntax colouring, for fenced blocks and for the diff an Edit/Write tool card
  holds — the language of the latter comes off the card's title, which for those tools **is** the
  file path. It owns the Prism grammar list (js/ts/jsx/tsx and java first, then the C family, the
  scripting and data languages, and `diff`), the alias and extension maps, and the token-type →
  `CODE` map, which reads a token's **type before its `alias`** because several grammars alias to
  something that reads wrong here — Java's `annotation` is aliased to `punctuation`, and
  alias-first would print `@Override` in the grey of a semicolon. Nested tokens **inherit** the
  enclosing colour, which is what makes a diff's `deleted-sign` (whose children carry no colour of
  their own) come out red at all. An unknown language, a missing grammar or anything thrown
  degrades to plain text: a block that renders uncoloured is a non-event, one that takes the log
  down with it is not. Colour lands on the spans and never in a stylesheet, for the reason
  `theme.ts` already documents about inline styles winning.
  `Elapsed.tsx` is the only thing in the UI
  that ticks: it re-renders three characters of duration instead of its host row, on an interval
  that follows the granularity on screen (1s while showing seconds, 15s once only minutes can
  change), and its `until` prop draws a *stopped* clock — the reading holds, no interval at all.

**Adding an IPC feature** touches four places in order: channel name in `src/shared/ipc.ts` →
handler in `src/main/ipc.ts` → typed method in `src/preload/index.ts` → renderer call via
`window.vivarium.*` (usually from a store action). No exceptions for chat — every one of its
outbound channels follows this path (the count used to be written down here and had already rotted
by three; `CH` is the list).

**`chat:event` is the one deliberate departure** from one-channel-per-payload: it carries a
discriminated `ChatEvent` union. `ptyData`/`ptyExit` can be separate channels safely because exit
is terminal and data is opaque bytes; chat's inbound is neither. A turn emits appended entries,
then the turn-end *replacement* of those same entries, plus blocking cards, task/todo, reset, the
whole-window replacement a revert sends (`rewound`, the one event that removes rows rather than
upserting them) and exit — and these are strictly ordered. Electron guarantees ordering **within** a channel, not
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
  **Five deliberate exceptions, all for the same reason** — these are *user preferences*, or facts
  that cannot be queried live, not runtime state observed from Docker:
  `Session.mode` and `Session.model` (how a chat's agent runs; `mode` restored at spawn as
  `--permission-mode` for bypass and as a control-channel transition for plan — see the
  plan-mode invariant below — `model` as `--model`), `Config.chatZoom` (the chat window's zoom — a fact about the
  monitor you are sitting at, and one the app was visibly forgetting on every launch), and
  `Session.previousClaudeSessionIds` +
  `Config.pendingTranscriptDeletes` — which are not really an exception at all, since a deletion
  you owe is exactly a fact that cannot be queried, Docker being down being *why* you owe it.
  `Session.rewound` is the fifth and lands on the strongest version of that same argument: a
  rewind you performed is a fact that cannot be queried *even with Docker up*, because Claude Code
  does not truncate the transcript when it winds a conversation back (see the revert invariant
  below).
  Deliberately **not** persisted, for contrast: the `list_models` result (global to the account,
  cached in main for the app run), the composer draft + pending chips, and `terminalFontSize` —
  which is the same *kind* of preference as `chatZoom` and is simply not what was asked for; if it
  ever is, it goes next to it in `Config` and follows the same path. `Project.slashCommands`
  *is* cached, on a different argument — it is a **hint, never authority**: the CLI always decides,
  so a stale entry can only mis-suggest, never mis-execute.
- **What `/` can expand is learned from `init` *and* from the disk, because `init` arrives too
  late.** Claude Code's own list is authoritative and comes only in a `system/init`, which is
  emitted at the **first turn of a process** and re-emitted only when a `set_model` /
  `set_permission_mode` arms it — so a chat opened this morning offers the list as of its last turn,
  and a skill written since is missing from the menu. There is no control request to ask with
  either: `list_models` has no `list_commands` sibling. The CLI itself is *not* stale — verified on
  2.1.226 that a `SKILL.md` created while the process ran appears in the next init it emits — so
  this is only ever a gap in the app's picture, and `ChatService.refreshCommands` closes it by
  counting the definitions in the container's four canonical directories
  (`<cwd>/.claude` and `$CLAUDE_CONFIG_DIR`, `commands/**.md` and `skills/*/SKILL.md`) and
  **merging**: `init`'s names first, the scan may only add. That keeps the built-ins, which live in
  the binary and are on no disk, and plugin skills, which the scan deliberately does not go looking
  for. It runs at open and when the composer's `/` menu opens, throttled — it is a `docker exec`,
  and the menu opens on every command you start typing. An `init` **replaces** rather than merges
  (it is the one reading that can also *drop* a deleted skill) and re-arms the throttle.
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
- **Claude Code is never updated under a running container — and always fresh in a new one.**
  Those are one rule, not two, and the line between them is `docker run`. It used to be updated by a
  fire-and-forget `npm i -g` on every container *start*, which invisibly changed the CLI version
  under live sessions; that is gone and stays gone. Updates to an existing container are
  user-initiated only: title-bar version chip / project context menu → the Claude Code dialog, which
  runs `sudo npm install -g …@latest` in one running container at a time. Consequences the UI states
  rather than hides: the CLI only exists inside containers (a stopped one has no version to read),
  and a running `claude` keeps its version until relaunched.
  The other half is `DockerService.freshenClaude`, on the **fresh-create path only**. The CLI is an
  image layer and `IMAGE_VERSION` is bumped roughly never, so a container created today is born on
  whatever version was current the day the image was built — months behind, and a `recreate` used to
  hand you that same regression on purpose. A container that has just been created has no session,
  no agent and no turn in it by construction, so there is nothing to change *under*; the install is
  awaited and streamed into the same terminal that shows the image build, so it is a step you watch.
  Every failure is non-fatal — the container is up and usable on the image's version. What decides
  "behind" is a numeric compare of the dotted parts (`isOlderVersion`, prerelease suffix stripped
  before the split or `2.1.226-rc.1` sorts *above* `2.1.226`), and "latest" is `ClaudeService`'s
  cached registry answer, handed down as a getter — `claude.ts` is built on `docker.ts`, so the
  dependency may not point back.
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
- **A chat is always *launched* in `bypassPermissions`, and a `plan` session is transitioned into
  plan mode over the control channel at spawn.** Never `--permission-mode plan` — the CLI (2.1.220)
  makes that a one-way door twice over: `isBypassPermissionsModeAvailable` is decided once at
  startup from `--permission-mode bypassPermissions || --dangerously-skip-permissions`, so every
  later `set_permission_mode bypassPermissions` is *refused* for the life of the process; and
  ExitPlanMode's approval path ends by setting the mode to `prePlanMode ?? 'default'`, where
  `prePlanMode` is only recorded by a transition **into** plan mode. Launched in plan there is no
  transition, so "Approve & run" landed the session in `default` — prompting for every edit, which
  is not one of this app's two modes — while the header read bypass. Entering plan mode from bypass
  answers both: bypass stays available, and the CLI's own plan exit restores the mode it came from,
  so the app asks for nothing on approval beyond a plain `allow`. A `set_permission_mode` refusal is
  therefore never swallowed: main puts the reading back rather than let the chip promise a mode the
  process is not in.
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
  from the turn's own start offset*, which makes settling twice idempotent — and idempotence is what
  lets a settle holding **less prose than the stream already painted be withheld rather than applied
  and repaired**: the CLI's last write is routinely still in flight when `result` arrives over the
  pipe, and a lost race used to blank the finished paragraph for the whole `RESETTLE_MS` before the
  re-read put it back. So the streamed rows stay on screen and the replacement waits for a file that
  has caught up (`SETTLE_ATTEMPTS` reads, then it accepts what it has). The prose comparison is
  **trimmed on both sides**: `ChatMapper` trims each text block and the stream keeps the deltas as
  they arrived, so counted raw a *complete* transcript scores below the stream on most turns and
  every turn looks like a lost race. An **aborted** turn is not settled but its bytes are still
  stepped over (`skipTurn`), or the next turn would map them again.
- **A revert is the CLI's own rewind, and the transcript does not shrink for it.** Esc Esc (or the
  log's context menu) opens `RewindOverlay`, and picking one of your messages winds the conversation
  back to just before it and hands its text back to the composer. The mechanism is Claude Code's
  `rewind_conversation` **control request**, on the channel `interrupt` / `set_model` already ride —
  it is undocumented, and `/rewind` the slash command is `supportsNonInteractive: false` so
  forwarding it through the composer cannot work in `-p` mode. Four facts about it, all read off the
  CLI (2.1.220) rather than guessed, and all load-bearing:
  (1) **It pops exactly one message** — anything newer than the target and it answers `stale target`,
  the test being "is there a later *human* user message", which is why a slash-command echo or an
  interrupt marker does not count. On success it truncates its own message array at the target, and
  *that* is what makes the next call to an earlier message legal. So reverting N messages is N
  sequential calls, newest first; the loop in `ChatService.rewind` is not an optimisation waiting to
  happen. (2) **The first message cannot be popped** (`no preceding assistant`, behind a gate that is
  off by default) — `/clear` is already that gesture and the overlay says so. (3) **It must be aimed
  from the *file*, not from `l.entries`**: an interrupted turn is `skipTurn`'d rather than settled, so
  its user row keeps the optimistic `you:<turn>` id it was painted with and carries no transcript
  uuid at all — target from memory and that message is unpoppable, which leaves every earlier one
  permanently `stale target` behind it. (4) **The file is not truncated.** A rewind *appends*
  `{"type":"last-prompt","leafUuid":…,"rewound":true}` and the CLI's loader takes the **last** such
  line's `leafUuid` as the live branch; the abandoned lines stay where they are forever.
  So the abandoned **byte range** is recorded on the session (`Session.rewound`) and subtracted by
  every later whole-file read — `walkTranscript` does the offset-tracking walk that `readHistory` and
  `rewind` share, and `mergeRanges` unions two reverts so the second swallows the first.
  **Do not "fix" this by following the branch pointer instead.** That was tried: `last-prompt` is
  written on *every* turn (2 287 of them across 115 real transcripts), so the filter would be live on
  every conversation rather than only reverted ones, and an ancestry walk from the leaf does not
  reconstruct the conversation, because compaction restarts the chain — measured on real files, one
  of 3 701 message lines has a 196-deep chain and another of 895 has a **5**-deep one. Replicating
  the loader means replicating compact boundaries and preserved segments, and its failure mode is
  blanking history on conversations nobody ever reverted. Two things the range record does not cover,
  by choice: a `/rewind` performed in an **xterm agent** on the same conversation (Vivarium cannot
  know, so that log will show abandoned turns), and the todo fold, which keeps abandoned entries
  until the next reopen rebuilds it. **File restore is deliberately absent**: `rewind_files` exists
  but checkpointing resolves through `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` in SDK mode, and
  `-p --input-format stream-json` *is* SDK mode, so it is dead until that env var is added to the
  `docker exec` — and it would restore into `/workspace`, a bind mount of a real checkout.
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
  minute for as long as the app is open. **The clock stops while any `can_use_tool` is outstanding**,
  and restarts when the card is answered: the CLI writes nothing at all until we answer, so a
  question or a plan left on screen for a minute used to fail its own turn under the user's hands —
  and a CLI blocked on a human is the one case that is provably not the broken CLI this detects.
  Nothing anywhere times a card out; the CLI has no such timeout either.
- **`terminal_reason` is the only test that distinguishes cancelled from failed.** `is_error` cannot
  — a clean deny-then-interrupt reports `is_error: true`. On reopen, where there is no
  `terminal_reason`, a cancelled tool is detected **structurally** (the error results with nothing
  after them in the turn but the interrupt marker), never by matching the refusal wording. The one
  prose-parsing rule left in the design is the *fallback* for recovering an answered
  `AskUserQuestion`, and even that is now anchored on the question texts the mapper already holds
  rather than sweeping the sentence for `"…"="…"` pairs — so a preview or a note quoting one cannot
  inject a phantom answer. Keeping it to one is why the cancelled rule is positional.
  **The `interrupted` row itself has two producers and they are not ordered against each other.**
  Claude Code writes a synthetic `[Request interrupted by user]` user message, which the mapper
  turns into that row, and `result` carries `terminal_reason` and produces one too — both arrive on
  the same stream, and one Esc used to print two rows. Neither can be dropped: the mapper's is what
  a *reopened* conversation renders (it is the one in the transcript), and `result`'s is the only
  row a CLI that emits no such message would produce at all. So whichever lands second is
  suppressed, per turn — never by a shared fixed id, or a conversation with five interrupted turns
  would collapse to one row.
- **The `AskUserQuestion` card is the whole tool, not a row of labels — and it is a popover over the
  log, not a band in it and not a dialog over everything.** The
  first version drew the
  option labels as chips, which silently dropped every affordance that makes the tool worth calling:
  the option **descriptions** (tooltip-only), the **previews** the model writes for you to compare,
  whether the question takes one answer or several, the **Other** free-text escape, and **Chat about
  this**. Rebuilt with all five it stopped fitting where the other blocking cards live: it is the one
  that is a *form* rather than a sentence with two buttons after it, and pinned *in* the band above
  the composer it was a 46vh scroller wedged between the log and the box, competing with both for
  height. It was then a modal dialog, which failed in the opposite direction and worse: a scrim over
  the log, no scrolling, and a question you cannot answer without re-reading the last three tool
  calls is exactly the question this tool asks.
  So `QuestionPopover` **floats** — absolutely positioned inside the log's own box and anchored to
  the bottom edge the composer starts at (`BlockingBar` still keeps the two one-line cases). Being
  *over* the log rather than *in* it is the whole trick: the scroller keeps every pixel of its
  height, so nothing re-pins and nothing reflows when the card appears or grows, and with no
  backdrop and `pointer-events: none` on the anchor box the wheel, the scrollbar, text selection and
  the composer all keep working underneath. Its ceiling is the log area, **measured** — everything
  inside a zoomed box is in zoomed units, so `room` is read off the unzoomed anchor in screen pixels
  and handed to the panel as `room / zoom` (a `getBoundingClientRect` taken *inside* the zoom is in
  those units too, which is a good way to convince yourself of a bug that is not there; verified at
  0.7×, 1× and 1.5×). There is no dismiss — "Chat about this" is the way out, since that is a real
  answer to the tool rather than a cancel, and dismissing would leave the CLI blocked with nothing
  on screen saying so. A single Esc keeps its single meaning, interrupt the turn, served by
  ChatView's window handler — and `RewindOverlay`, which the *second* Esc of a pair opens, is still
  a real dialog with a scrim that dismisses on click, precisely because nothing is blocked behind it
  and the conversation under it is not what you are reading. The
  options are drawn controls (a rounded box with a tick, a circle with a dot) rather than `[x]` and
  `( )` typed in mono: this window is not a terminal, and the ASCII markers made a clickable list
  read as output. Four facts hold that surface up, and all four are read off the CLI's own dialog
  rather than guessed:
  - **"Other" is not a separate `response` field, it is an answer.** The dialog files the typed text
    under the question like any label, so it comes back as `"q"="<what you typed>"` and the model
    gets *The user answered: …* — the wording that tells it to read the answer rather than assume it
    picked an option. `response` exists and is deliberately unused.
  - **Multi-select answers travel joined with `", "`, as a string.** An array survives the wire (the
    schema's preprocess joins it, but `call()` reads the raw input), which is exactly why it must not
    be sent: the CLI stringifies it as `A,B` while its own dialog sends `A, B`, and the result
    builder splits on the latter to decide the answer was well formed. The renderer splits back only
    when every part is a real option label — a single-select answer may legitimately contain a comma.
  - **"Chat about this" is a `deny`, not an empty `allow`.** An `allow` with no answers yields *"The
    user did not answer the questions."* and the agent carries on with its own guess. The denial
    carries the CLI's own clarify prose plus whatever was half-filled in, so the next composer
    message lands in a turn that is already listening.
  - **`updatedInput` is re-validated against the tool's schema**, so `answers` and `annotations` must
    be shaped right — but unknown *keys* are tolerated (the CLI drops `unrecognized_keys` issues
    before deciding the host sent something invalid), which is what makes a forward-compatible field
    safe to add later.
  The settled row does **not** re-derive any of this from prose: the transcript line's own
  `toolUseResult` carries `{questions, answers, annotations}` keyed by question text, which is exact.
- **The context meter is only ever as fresh as the last thing that asked for it**, so changing the
  model has to ask. `get_context_usage` is polled at open (the load-bearing half: nothing is
  emitted on the wire until the first user message, so a chat reopened onto 80k of history would
  otherwise show an empty meter at exactly the moment you look at it), at every `result`, and now
  after `set_model` — the ceiling is a property of the model, and picking one used to leave a 200k
  scale reading 1M until the next turn happened to refresh it. `setModel` also adopts the
  *resolved* model for display while `Session.model` keeps the **alias**: the alias is what
  `--model` needs at the next spawn, and the resolved id is what makes the chip say `Opus 5`
  instead of `Opus`.
- **The turn clock's token reading steps per API message and is never estimated between them.**
  Claude Code reports usage twice per message — provisionally at
  `stream_event/message_start`, finally at `message_delta` — and once for the whole turn at
  `result`, and the two agree exactly (a three-message turn's `result.usage.output_tokens` was
  75+75+5, verified on 2.1.220). So the live row is the sum of the latest report per message id
  (`Live.usage`, keyed per message because a single accumulator would add both reports and double
  the turn) and the freeze adopts `result.usage`, which no user can see as a correction. Nothing is
  reported *inside* a message, so on a turn of one long answer the number appears at the end;
  interpolating characters ÷ 4 was rejected on the precedent the interrupted turn's duration set —
  and it is not even close, a 60-line list of numbers being 179 characters for 149 output tokens.
  **Subagent tokens are excluded because `result.usage` excludes them** (verified: 213 for a turn
  whose subagent spent 6; they surface only in `result.modelUsage`, which is per model and also
  counts the account's title-generation Haiku calls), so counting the frames
  `--forward-subagent-text` forwards would make the live number overshoot the CLI's own total.
  Only `output` is on screen: the whole context is re-sent every message, so a summed input across a
  ten-message turn reads as ten times the context — a cost the turn did not incur, and a question
  the header's context meter already answers. The other three ride the row's tooltip.
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
  **The corollary binds everything in the pinned bands: a hover may not change their height.**
  Todo strip, blocking bar and chip strip all sit between the log and the composer, so any pixel
  they gain or lose is a pixel the *scroller* loses or gains, and the observer answers by re-pinning
  the tail. The question card's preview pane learned this the hard way — it swapped its content on
  hover, so moving down a list of options jumped the whole conversation once per row. It lays every
  option's preview into one grid cell and hides all but the focused one (`visibility`, which keeps
  layout), so the pane is the size of the tallest from the moment it appears. That card floats now
  (absolutely positioned, out of the flow) and so is out from under this rule, and the technique
  stays anyway — a card that resizes under the pointer is its own bug. Reserve the space; do not
  compute it against font metrics, and do not re-measure on hover.
- **The turn clock draws at the bottom of the log while it is running.** It is appended at *send*,
  before a word of the answer exists, so in list order it sits directly under your message and the
  whole turn then grows below the row reporting on it — `working · 4s` is a reading about right
  now, and right now is the tail. The move is `ChatView`'s (`rows`), keyed on `durationMs` being
  undefined so only the live clock is touched; a frozen one is a fact about a finished turn and
  stays in its place in time. That place is the **end** of the turn, which takes agreement in three
  files: `settleTurn` puts the kept clock last (`[...mapper.entries, ...clock]`, matching where the
  mapper puts a `turn_duration` row on reload), `freezeTurnClock` moves it to the end of main's
  array, and the store's `applyEntries` moves it to the end of the renderer's — which it must do
  explicitly, since it upserts by id and would otherwise leave `done · 12s` above the answer for
  the second between the freeze and the settle.
- **Chat zoom is CSS `zoom` on the two columns, never on the view root.** The chat is a whole
  layout — a gutter, cards, a composer — so scaling only the type would leave all of it behind at
  its 1× proportions. The root is `position:absolute; inset:0` and a zoomed box scales its own
  edges; the columns are plain auto-width blocks, which fill the scroller at any factor exactly the
  way browser zoom behaves. There is no `max-width` on either one, and that is the second half of
  the same story: the log used to be capped at an 880px reading measure and centred, so a maximised
  window drew the conversation as a ribbon between two wide bands of dead background — worse on the
  left, where the gutter column sat inside it and the prose started another 100px in (that column is
  gone too now, for the same reason and on the same argument). The cap needed
  a `columnMax(zoom)` to divide it back out below 1× (a `max-width` is in *zoomed* pixels, so
  zooming out pulled both edges in from the window); removing it removed that too. **The window is
  the measure now** — the user sizes it. All the two columns still share is `CHAT_EDGE`, and they
  must keep sharing it or the log and the box you answer in stop lining up.
  `chatZoom` is **persisted** (`Config.chatZoom`, read in `init`, written through a 300ms-debounced
  `persistZoom` — a scroll gesture is thirty notches and each write is a whole-config atomic
  rename), and shared by every chat: you zoom because of the monitor you are sitting at, not
  because of the conversation. Ctrl +/-/0 and Ctrl+wheel, the chords `TerminalView` already binds,
  and the log's context menu is where they are written down (the terminal's menu is the precedent:
  a chord nothing on screen mentions may as well not exist).
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
