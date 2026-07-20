// Shared types used by both the main process and the renderer.

export type ImageVariant = 'slim' | 'full'

export type SessionType = 'agent' | 'container-shell' | 'host-shell'

export interface Session {
  id: string
  name: string
  type: SessionType
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

export type AgentActivity = 'idle' | 'working'

/** Claude Code hook events forwarded from the container bridge (see main/bridge.ts). */
export type AgentHookKind = 'UserPromptSubmit' | 'Stop'

export interface AgentHookEvent {
  sessionId: string
  kind: AgentHookKind
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
