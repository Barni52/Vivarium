// Shared types used by both the main process and the renderer.

export type ImageVariant = 'slim' | 'full'

export type SessionType = 'agent' | 'container-shell' | 'host-shell'

export interface Session {
  id: string
  name: string
  type: SessionType
  /**
   * For `agent` sessions only: a stable UUID pinned as Claude Code's own
   * conversation id (`claude --session-id <uuid>` on first launch, `--resume <uuid>`
   * after), so a conversation survives the container being stopped/recreated and the
   * app restarting — the transcript persists on the claude-box-creds volume, and we
   * re-attach the *conversation* without any multiplexer. Undefined for shell
   * sessions, and for legacy agent sessions until backfilled on config load.
   */
  claudeSessionId?: string
}

export interface Project {
  id: string
  name: string
  /** Absolute host path the project is rooted at (host shells cwd here). */
  basePath: string
  /** Absolute host paths of the subfolders mounted into the container. */
  mounts: string[]
  image: ImageVariant
  /** Only meaningful for `full` projects; slim projects never publish a port. */
  publishedPort?: number
  sessions: Session[]
}

export interface Config {
  version: 1
  projects: Project[]
  /**
   * Absolute host path of the shared output folder, mounted read-write into
   * every container at /workspace/output. Where agents drop artifacts (HTML,
   * etc.) the user wants to read. Optional / may be unset.
   */
  sharedOutputFolder?: string
  /**
   * Base ref the "Write branch diff" project action diffs the current branch
   * against (e.g. "origin/master"). Defaults to "origin/master" when unset.
   */
  diffBase?: string
}

/** Result of the "Write branch diff" project action. */
export interface DiffResult {
  ok: boolean
  message: string
}

/** One node in the shared-output-folder file tree. */
export interface OutputNode {
  name: string
  /** absolute host path */
  path: string
  type: 'file' | 'dir'
  children?: OutputNode[]
}

/** Live container state (queried from docker, not persisted). */
export interface ContainerState {
  projectId: string
  running: boolean
  exists: boolean
}

/**
 * What an agent is doing right now. 'waiting' is still mid-turn — the agent has
 * blocked on the user (a question, or a plan waiting for approval) and is
 * burning no time at all, which is why it is a state of its own rather than a
 * flavor of 'working': the turn clock pauses for exactly as long as it lasts.
 */
export type AgentActivity = 'idle' | 'working' | 'waiting'

/**
 * Claude Code hook events forwarded from the container bridge (see
 * main/bridge.ts). `AskUserQuestion`/`ExitPlanMode` are the two tools whose
 * "execution" is waiting for the user; `Resumed` is their PostToolUse, i.e. the
 * answer landed and the agent is running again.
 */
export type AgentHookKind =
  | 'UserPromptSubmit'
  | 'Stop'
  | 'AskUserQuestion'
  | 'ExitPlanMode'
  | 'Resumed'

export interface AgentHookEvent {
  sessionId: string
  kind: AgentHookKind
  /**
   * Epoch ms, stamped on the HOST when the bridge read the line, not the
   * container-side timestamp the hook writes into events.log: a WSL2 clock drifts
   * from Windows across host sleep, and these values are subtracted from
   * `Date.now()` to show "working 4m", so a skewed one would print a negative or
   * absurd turn. The log keeps its own timestamp for post-mortem reading only.
   */
  at: number
}

/**
 * One rate-limit window from the (undocumented) Claude OAuth usage endpoint —
 * `kind` is 'session' (5h) / 'weekly_all' / 'weekly_scoped' (per-model, see
 * modelName) today, but treated as an open string since the API is unstable.
 */
export interface UsageLimit {
  kind: string
  /** 0-100 (the endpoint may report fractions) */
  percent: number
  /** 'normal' until Anthropic escalates it — surfaced in the tooltip only */
  severity: string
  /** ISO timestamp, null if the endpoint omitted it */
  resetsAt: string | null
  /** display name for weekly_scoped limits (e.g. "Fable"), null otherwise */
  modelName: string | null
  isActive: boolean
}

/** Claude plan usage fetched by main (see main/usage.ts). */
export interface UsageSnapshot {
  ok: boolean
  /** when ok=false: 'no-credentials' | 'auth-expired' | 'network' | http status text */
  error?: string
  limits: UsageLimit[]
  fetchedAt: number
}

/**
 * Claude Code version state for one project's container. The CLI is installed
 * *inside* the container (image layer + whatever a manual update put in the
 * writable layer), so there is nothing to read while it isn't running.
 */
export interface ClaudeVersionInfo {
  projectId: string
  /** version read from the container, null when it couldn't be read */
  installed: string | null
  /** why `installed` is null: 'stopped' | 'no-container' | 'docker-missing' | 'error' */
  reason?: 'stopped' | 'no-container' | 'docker-missing' | 'error'
}

/** Snapshot behind the title-bar version chip and the Claude Code dialog. */
export interface ClaudeStatus {
  /** newest version published on npm, null when the check failed */
  latest: string | null
  /** why `latest` is null: 'network' | 'offline' | `http-<status>` */
  latestError?: string
  /** epoch ms of the last successful npm check; 0 = never succeeded */
  checkedAt: number
  containers: ClaudeVersionInfo[]
}

/** Result of one manual "update Claude Code in this container" run. */
export interface ClaudeUpdateResult {
  ok: boolean
  /** version read back after the install, null when unreadable */
  version: string | null
  /** short error tail when ok=false */
  message?: string
}

/**
 * One docker volume, as shown in the Volumes dialog.
 *
 * Three kinds exist:
 *  - `shared`   the claude-box-creds / claude-box-home pair. Auth, settings and
 *               agent memory live here and they are deliberately shared with the
 *               user's older claude-box setup — never removable from the UI.
 *  - `shadow`   `vivarium-<hash>-<suffix>`: a container-local overlay on one
 *               mounted folder's build output (node_modules, Maven target …).
 *               `hash` identifies the host path, so a volume whose hash matches
 *               no current mount is orphaned — its folder was unmounted or its
 *               project deleted, and nothing else will ever clean it up.
 *  - `other`    any remaining `vivarium-*` volume (dev leftovers, older naming).
 */
export interface VolumeInfo {
  name: string
  kind: 'shared' | 'shadow' | 'other'
  /** docker's own human-readable size, e.g. "1.21GB"; null when unreported */
  size: string | null
  /** same size in bytes, for totals and sorting; null when unparseable */
  bytes: number | null
  /** containers currently using it — docker refuses to remove a volume in use */
  links: number
  /** what a shadow volume overlays ("node_modules"), null for the other kinds */
  contents: string | null
  /** projects whose mounts produced this volume; empty means orphaned */
  projects: string[]
  /** never offer removal (the shared pair) */
  locked: boolean
}

/** Volumes plus whether the size sweep actually reported anything. */
export interface VolumeReport {
  volumes: VolumeInfo[]
  /** false when `docker system df` failed — names are listed, sizes are null */
  sized: boolean
  error?: string
}

/** Result of removing one volume. */
export interface VolumeRemoveResult {
  ok: boolean
  /** docker's message when ok=false (e.g. "volume is in use") */
  message?: string
}

/** Versions shown on the title-bar chip — enough to paste into a bug report. */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
}

/** Taskbar overlay badge pushed by the renderer (drawn there — main has no canvas). */
export interface BadgePayload {
  /** outstanding attention count (finished + asking agents); 0 clears the overlay */
  count: number
  /** 32×32 PNG data URL of the count disc, null when count is 0 */
  dataUrl: string | null
  /** flash the taskbar button — set for events arriving while unfocused */
  flash: boolean
}

/** Result of trying to open a session's pty. */
export interface SpawnResult {
  ok: boolean
  /** Present when ok === false, e.g. 'container-stopped' | 'docker-missing'. */
  reason?: string
  message?: string
}

/** Payload streamed from a pty to the renderer. */
export interface PtyDataEvent {
  sessionId: string
  data: string
}

export interface PtyExitEvent {
  sessionId: string
  exitCode: number
}

/** Docker availability + build progress signalling. */
export interface DockerStatus {
  available: boolean
  binary: string | null
  message?: string
}

/** Draft used by the Add-Project dialog. */
export interface NewProjectInput {
  name: string
  basePath: string
  mounts: string[]
  image: ImageVariant
  publishedPort?: number
}

/** Patch used by the Project-Settings dialog. */
export interface UpdateProjectInput {
  id: string
  name: string
  basePath: string
  mounts: string[]
  image: ImageVariant
  publishedPort?: number
}
