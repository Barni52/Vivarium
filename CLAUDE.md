# CLAUDE.md

Vivarium is a **Windows-only Electron desktop app**: a session manager that runs Claude Code
agents in per-project Docker containers with selective folder mounts, plus container-bash and
host-PowerShell terminals, all in one xterm view. Personal corporate tool — no external users.

## Architecture

electron-vite with three build targets (aliases `@shared`, `@renderer`):

- `src/main/` — Electron main process.
  - `ipc.ts` — `registerIpc()`: every IPC handler, the output-folder watcher, the taskbar badge.
  - `docker.ts` — `DockerService`: container lifecycle, `docker run` arg construction, image
    builds streamed line-by-line into the session terminal, plus the volume inventory behind
    the Volumes dialog (`listVolumes` / `removeVolume`).
  - `dockerfiles.ts` — inline slim/full Dockerfiles, `IMAGE_VERSION`, shared volume names.
  - `pty.ts` — `PtyManager`: node-pty processes keyed by session id.
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
- `src/shared/` — `ipc.ts` (channel names, `CH`) and `types.ts` (all cross-process types).
- `src/renderer/src/` — React + zustand + xterm. `state/store.ts` is the single store for all
  UI state. `TerminalHost` keeps one long-lived `TerminalView` per opened session — hidden on
  deselect, never destroyed, so scrollback survives switching. `theme.ts` owns the palette *and*
  `SESSION_TYPES` — the one place session-type wording, hue and popover geometry are defined;
  the picker, sidebar, terminal header and empty state all read from it, and `TypeIcon` gives
  each type its own silhouette so they never depend on color alone. `Elapsed.tsx` is the only
  thing in the UI that ticks: it re-renders three characters of duration instead of its host
  row, and its interval follows the granularity on screen (1s while showing seconds, 15s once
  only minutes can change).

**Adding an IPC feature** touches four places in order: channel name in `src/shared/ipc.ts` →
handler in `src/main/ipc.ts` → typed method in `src/preload/index.ts` → renderer call via
`window.vivarium.*` (usually from a store action).

## Invariants — do not break

- The docker logic was ported from `claude-box.ps1` (since removed from the repo — see git
  history if needed). The `(ref 123-456)` comments in `docker.ts` point at line numbers in that
  original script.
- Quitting the app **never stops containers** — only each project's explicit stop control does.
  App quit only kills local pty processes (`PtyManager.killAll`).
- **No multiplexer by design** (tmux was deliberately removed). Agent sessions die with the app
  and cannot be reattached across restarts — accepted model, don't add tmux/reattach logic.
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
- Mounts may only change while the container is stopped (`ipc.ts` enforces it); saving settings
  on a running container recreates it.
- **All terminal resizing goes through `fitNow()`** in `TerminalView` — never call `fit.fit()` or
  `resizeSession` directly. FitAddon clamps a collapsed container to 2×1 instead of refusing, and
  a 2-column fit reflows the whole 50k-line scrollback irrecoverably. `fitNow` also only messages
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
- **Claude Code is never auto-updated.** It used to be (fire-and-forget `npm i -g` on every
  container start, throttled by a stamp file) — invisible, and it changed the CLI version under
  a live session. Now updates are strictly user-initiated: the title-bar version chip / project
  context menu → the Claude Code dialog, which runs `sudo npm install -g …@latest` inside one
  running container at a time. Consequences the UI states rather than hides: the CLI only exists
  inside containers (a stopped one has no version to read), a `claude` already running keeps its
  version until relaunched, and since the install lands in the writable layer a `recreate`
  reverts it to the image's version — the chip re-flags it instead of silently self-healing.
- **Agent turn durations run on the host clock.** `hook.sh` writes a container-side timestamp
  into `events.log`, and `bridge.ts` deliberately ignores it: the events are stamped with
  `Date.now()` when the host *reads* the line (`AgentHookEvent.at`). A WSL2 VM's clock drifts
  from Windows across host sleep, and these values are subtracted from the renderer's clock to
  show "working 4m" — a skewed one would print a negative or absurd turn. The log keeps its own
  timestamp for post-mortem reading only. `agentSince` (store) is stamped on real transitions
  only, so a pty exit reporting idle for an already-idle agent can't claim its turn just ended;
  `UserPromptSubmit` re-stamps unconditionally, since a queued prompt starts a new turn while
  the state is already `working`.
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
- Agent idle/working detection and the attention-notification are driven by **Claude Code
  hooks** (`UserPromptSubmit`/`Stop`, plus a `PreToolUse` matcher on `AskUserQuestion` so a
  waiting question also raises the "!"), not by parsing terminal output. Agents launch with
  `--settings /vivarium/hooks.json` + `-e VIVARIUM_SESSION_ID=<id>`; the hook script appends
  to `/vivarium/events.log`, which the main process tails (`bridge.ts`). Never scope the hooks
  via the shared `/home/node/.claude/settings.json` — that would leak them into claude-box
  sessions. Gotchas: `Stop` does not fire on a user esc-interrupt (the renderer resets the
  indicator on Esc), bridge files are rewritten and the log truncated on every container
  start, and `start()` auto-recreates containers that lack the `/vivarium` mount.

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
2. A headless smoke run of the real app inside this dev container (Linux):
   - Electron's system libs are not baked into the image; after a container recreation:
     `sudo apt-get install -y --no-install-recommends libgtk-3-0 libnss3 libasound2 libgbm1 libxss1`
   - `nohup Xvfb :93 -screen 0 1600x1000x24 &` (nohup specifically; plain `&` dies with the
     shell — verify with `DISPLAY=:93 xset q`)
   - `ELECTRON_DISABLE_SANDBOX=1 VIVARIUM_CDP_PORT=9366 DISPLAY=:93 nohup npm run dev &`
     — `VIVARIUM_CDP_PORT` keeps the window hidden and exposes CDP on that port.
   - Drive it with Playwright: `chromium.connectOverCDP('http://127.0.0.1:9366')`; the app page
     is the one on `localhost:5173`. `window.__vivTerms[sessionId]` exposes each session's
     xterm instance for reading scrollback.
   - Vite HMR does not fire on this bind mount — kill Electron
     (`ps aux | grep '[e]lectron/dist'`) and relaunch to pick up renderer edits.
3. Anything docker-, pwsh-, or WSL-dependent cannot run in this container — the user verifies
   those paths on the Windows host. Say so explicitly instead of claiming verification.

## Code style

- Prettier-ish: 2-space indent, single quotes, no semicolons, explicit return types on
  functions.
- **Comment policy (overrides the global no-comments rule):** this repo is deliberately
  densely commented. New code should keep that style — explain Windows quirks, docker gotchas,
  and non-obvious design decisions inline, focusing on *why* and on constraints the code can't
  express.
- Cross-process types live in `src/shared/types.ts`; renderer-only types stay in the renderer.
