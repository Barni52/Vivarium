# CLAUDE.md

Vivarium is a **Windows-only Electron desktop app**: a session manager that runs Claude Code
agents in per-project Docker containers with selective folder mounts, plus container-bash and
host-PowerShell terminals, all in one xterm view. Personal corporate tool — no external users.

## Architecture

electron-vite with three build targets (aliases `@shared`, `@renderer`):

- `src/main/` — Electron main process.
  - `ipc.ts` — `registerIpc()`: every IPC handler, the output-folder watcher, the taskbar badge.
  - `docker.ts` — `DockerService`: container lifecycle, `docker run` arg construction, image
    builds streamed line-by-line into the session terminal.
  - `dockerfiles.ts` — inline slim/full Dockerfiles, `IMAGE_VERSION`, shared volume names.
  - `pty.ts` — `PtyManager`: node-pty processes keyed by session id.
  - `bridge.ts` — the agent hook bridge: per-project host dir (bind-mounted at `/vivarium`)
    holding Claude Code hook settings + `hook.sh`; `BridgeWatcher` tails its `events.log`.
  - `config.ts` — atomic persistence of the single `%APPDATA%/vivarium/config.json`.
  - `git.ts` — branch detection (reads `.git/HEAD` directly) + "Write branch diff" →
    `<sharedOutputFolder>/changes.txt`.
  - `clipboard.ts` — Ctrl+V image paste → PNG in the project clip dir (mounted at `/clip`).
- `src/preload/index.ts` — the typed `window.vivarium` API. The renderer never touches
  `ipcRenderer` directly.
- `src/shared/` — `ipc.ts` (channel names, `CH`) and `types.ts` (all cross-process types).
- `src/renderer/src/` — React + zustand + xterm. `state/store.ts` is the single store for all
  UI state. `TerminalHost` keeps one long-lived `TerminalView` per opened session — hidden on
  deselect, never destroyed, so scrollback survives switching.

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
