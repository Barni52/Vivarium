import { create } from 'zustand'
import type {
  AgentHookEvent,
  ClaudeStatus,
  ClaudeUpdateResult,
  Config,
  ContainerState,
  DockerStatus,
  ImageVariant,
  OutputNode,
  Project,
  SessionType,
  AgentActivity,
  UsageSnapshot
} from '@shared/types'
import { behindIds } from '../claude'
import { ADD_SESSION_POPOVER } from '../theme'

/** Why an agent session is flagged: turn finished, or blocked on AskUserQuestion. */
export type AttentionKind = 'finished' | 'question'

/** Container lifecycle operation currently in flight for a project. */
export type ContainerOp = 'start' | 'stop' | 'restart'

export type DialogKind =
  | 'addProject'
  | 'settings'
  | 'addSession'
  | 'confirmKill'
  | 'confirmDeleteProject'
  | 'confirmQuit'
  | 'claudeUpdate'
  | null

export interface ContextMenuItem {
  /** '---' renders a separator; label otherwise */
  label: string
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
  /**
   * Called after the menu closes via a keep-me-here gesture (item selection or
   * Escape). The terminal passes this to restore its focus so the user can keep
   * typing — sidebar/output menus omit it so they don't steal focus (e.g. from
   * the rename input).
   */
  onClose?: () => void
}

export interface DragState {
  kind: 'project' | 'session'
  id: string
  projectId?: string
}

export interface DropTarget {
  id: string
  pos: 'before' | 'after'
}

export interface ProjectDraft {
  name: string
  basePath: string
  mounts: string[]
  mountDraft: string
  image: ImageVariant
  port: string
}

export interface SettingsDraft extends ProjectDraft {
  id: string
  locked: boolean
}

export interface AddSessionDraft {
  projectId: string
  top: number
  left: number
  type: SessionType
  name: string
}

interface KillTarget {
  projectId: string
  sessionId: string
  name: string
}

interface DeleteProjectTarget {
  id: string
  name: string
}

interface AppState {
  config: Config
  states: Record<string, ContainerState>
  branches: Record<string, string | null>
  docker: DockerStatus | null
  outputTree: OutputNode[]
  outputExpanded: Record<string, boolean>
  outputCollapsed: boolean
  /** user-dragged height of the shared-output panel body (px, session-only like sidebarWidth) */
  outputHeight: number
  selectedSessionId: string | null
  expanded: Record<string, boolean>
  sidebarWidth: number
  sidebarCollapsed: boolean
  terminalFontSize: number
  /** session ids that currently have a live pty */
  live: Record<string, boolean>
  activity: Record<string, AgentActivity>
  /** agent sessions needing attention while unwatched — "!" (finished) or "?" (question) until opened */
  notifications: Record<string, AttentionKind>
  /** container start/stop/restart currently in flight, keyed by project id */
  containerOps: Record<string, ContainerOp>
  /** last failed container op's message, keyed by project id (auto-clears) */
  containerErrors: Record<string, string>
  /** claude plan usage shown in the title bar; null until the first poll lands */
  usage: UsageSnapshot | null
  /** Claude Code versions (per container + npm's latest); null until first check */
  claude: ClaudeStatus | null
  /** a version check is in flight (drives the chip/dialog "checking…" state) */
  claudeChecking: boolean
  /** project ids whose container is mid-update */
  claudeUpdating: Record<string, boolean>
  /** last update outcome per project, kept until the dialog closes */
  claudeResults: Record<string, ClaudeUpdateResult>

  dialog: DialogKind
  ap: ProjectDraft
  st: SettingsDraft | null
  addSession: AddSessionDraft | null
  /**
   * Type the picker preselects — the last one that was actually created.
   * Session-only on purpose: it's a "carry on doing what you were doing" hint,
   * not a setting, and it shouldn't outlive the app run.
   */
  lastSessionType: SessionType
  killTarget: KillTarget | null
  deleteTarget: DeleteProjectTarget | null
  editingSessionId: string | null
  editDraft: string
  contextMenu: ContextMenuState | null
  drag: DragState | null
  dropTarget: DropTarget | null

  init: () => Promise<void>
  refreshStates: () => Promise<void>
  refreshBranches: () => Promise<void>
  refreshUsage: () => Promise<void>

  // claude code version / manual update
  refreshClaude: (force?: boolean) => Promise<void>
  openClaudeUpdate: () => void
  updateClaudeIn: (projectId: string) => Promise<void>
  updateClaudeAll: () => Promise<void>

  // shared output folder
  setSharedOutput: (folder: string | null) => Promise<void>
  refreshOutputTree: () => Promise<void>
  openOutputFile: (abs: string) => void
  openOutputFolder: () => void
  deleteOutputPath: (abs: string) => Promise<void>
  toggleOutputDir: (path: string) => void
  toggleOutputPanel: () => void
  setOutputHeight: (n: number) => void

  // git diff → changes.txt
  setDiffBase: (value: string) => Promise<void>
  runProjectDiff: (projectId: string) => Promise<void>

  select: (sessionId: string) => void
  toggle: (projectId: string) => void
  setSidebarWidth: (n: number) => void
  toggleSidebar: () => void
  zoomTerminal: (delta: number) => void
  resetTerminalZoom: () => void
  setLive: (sessionId: string, live: boolean) => void
  setActivity: (sessionId: string, a: AgentActivity) => void
  notifyAgentAttention: (sessionId: string, kind: AttentionKind) => void
  handleAgentHook: (e: AgentHookEvent) => void

  // dialogs
  openAddProject: () => void
  openSettings: (projectId: string) => void
  openAddSession: (projectId: string, anchor: DOMRect) => void
  closeDialog: () => void
  requestQuit: () => void
  confirmQuit: () => void
  setAp: (patch: Partial<ProjectDraft>) => void
  setSt: (patch: Partial<SettingsDraft>) => void
  setAddSession: (patch: Partial<AddSessionDraft>) => void

  // mutations
  createProject: () => Promise<void>
  saveSettings: () => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  requestDeleteProject: (projectId: string, name: string) => void
  confirmDeleteProject: () => Promise<void>

  // context menu
  openContextMenu: (x: number, y: number, items: ContextMenuItem[], onClose?: () => void) => void
  closeContextMenu: () => void

  // drag reorder
  setDrag: (drag: DragState | null) => void
  setDropTarget: (t: DropTarget | null) => void
  reorderProjects: (orderedIds: string[]) => Promise<void>
  reorderSessions: (projectId: string, orderedSessionIds: string[]) => Promise<void>
  confirmAddSession: () => Promise<void>
  startRename: (sessionId: string, name: string) => void
  setEditDraft: (v: string) => void
  commitRename: (projectId: string) => Promise<void>
  cancelRename: () => void
  requestKill: (projectId: string, sessionId: string, name: string) => void
  confirmKill: () => Promise<void>

  // container power
  togglePower: (projectId: string) => Promise<void>
  restart: (projectId: string) => Promise<void>
  runContainerOp: (projectId: string, op: ContainerOp) => Promise<void>
}

const emptyDraft = (): ProjectDraft => ({
  name: '',
  basePath: '',
  mounts: [],
  mountDraft: '',
  image: 'slim',
  port: ''
})

export function defaultSessionName(project: Project | undefined, type: SessionType): string {
  const base = type === 'agent' ? 'agent' : type === 'container-shell' ? 'bash' : 'ps-host'
  const n = (project?.sessions.filter((s) => s.type === type).length ?? 0) + 1
  return `${base}-${n}`
}

function parsePort(v: string): number | undefined {
  const n = parseInt(v.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// Taskbar overlay disc with the outstanding-attention count. Drawn here — the
// main process has no canvas — and shipped over IPC as a data URL.
function badgeDataUrl(count: number): string {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 32
  const g = c.getContext('2d')
  if (!g) return ''
  g.beginPath()
  g.arc(16, 16, 16, 0, Math.PI * 2)
  g.fillStyle = '#fa4d56'
  g.fill()
  const label = count > 9 ? '9+' : String(count)
  g.fillStyle = '#fff'
  g.font = `bold ${label.length > 1 ? 16 : 20}px 'IBM Plex Sans', system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, 16, 17)
  return c.toDataURL('image/png')
}

// Mirror the notifications map onto the taskbar badge. Called after every
// mutation of the map — the count only clears by viewing each flagged session,
// not by focusing the window, so "how much stuff is done" stays glanceable.
function pushBadge(notifications: Record<string, AttentionKind>, flash: boolean): void {
  const count = Object.keys(notifications).length
  window.vivarium.setBadge({
    count,
    dataUrl: count > 0 ? badgeDataUrl(count) : null,
    flash
  })
}

export const useStore = create<AppState>((set, get) => ({
  config: { version: 1, projects: [] },
  states: {},
  branches: {},
  docker: null,
  outputTree: [],
  outputExpanded: {},
  outputCollapsed: false,
  outputHeight: 200,
  selectedSessionId: null,
  expanded: {},
  sidebarWidth: 292,
  sidebarCollapsed: false,
  terminalFontSize: 13,
  live: {},
  activity: {},
  notifications: {},
  containerOps: {},
  containerErrors: {},
  usage: null,
  claude: null,
  claudeChecking: false,
  claudeUpdating: {},
  claudeResults: {},
  dialog: null,
  ap: emptyDraft(),
  st: null,
  addSession: null,
  lastSessionType: 'agent',
  killTarget: null,
  deleteTarget: null,
  editingSessionId: null,
  editDraft: '',
  contextMenu: null,
  drag: null,
  dropTarget: null,

  init: async () => {
    const [config, docker] = await Promise.all([
      window.vivarium.loadConfig(),
      window.vivarium.dockerStatus()
    ])
    const expanded: Record<string, boolean> = {}
    for (const p of config.projects) expanded[p.id] = true
    set({ config, docker, expanded })
    await Promise.all([
      get().refreshStates(),
      get().refreshBranches(),
      get().refreshOutputTree()
    ])
    // Unawaited: the version chip is the least urgent thing on screen, and the
    // container probes behind it are slow enough to hold up first paint.
    void get().refreshClaude()
  },

  refreshStates: async () => {
    const states = await window.vivarium.containerStates()
    const map: Record<string, ContainerState> = {}
    for (const s of states) map[s.projectId] = s
    set({ states: map })
  },

  refreshBranches: async () => {
    set({ branches: await window.vivarium.projectBranches() })
  },

  refreshUsage: async () => {
    const next = await window.vivarium.fetchUsage()
    // A failed poll must not wipe live chips: keep the last good snapshot and
    // let the countdown keep interpolating off the app clock — the TitleBar
    // surfaces staleness from the old fetchedAt. Errors only land when there
    // is nothing better to show.
    set((s) => (next.ok || !s.usage || !s.usage.ok ? { usage: next } : {}))
  },

  // ---- claude code version / manual update --------------------------------
  // No auto-update anywhere: this only ever *reads* versions. Installing is
  // strictly a user action (updateClaudeIn / updateClaudeAll).
  refreshClaude: async (force = false) => {
    if (get().claudeChecking) return // coalesce overlapping checks
    set({ claudeChecking: true })
    try {
      set({ claude: await window.vivarium.claudeStatus(force) })
    } finally {
      set({ claudeChecking: false })
    }
  },

  // Always force-refresh on open: the dialog is the one place the numbers are
  // read closely, and it's opened rarely enough that a live npm hit is free.
  openClaudeUpdate: () => {
    set({ dialog: 'claudeUpdate', claudeResults: {} })
    void get().refreshClaude(true)
  },

  updateClaudeIn: async (projectId) => {
    if (get().claudeUpdating[projectId]) return
    set((s) => {
      const claudeResults = { ...s.claudeResults }
      delete claudeResults[projectId] // clear a previous failure's message
      return { claudeUpdating: { ...s.claudeUpdating, [projectId]: true }, claudeResults }
    })
    const result = await window.vivarium.claudeUpdate(projectId)
    set((s) => {
      const claudeUpdating = { ...s.claudeUpdating }
      delete claudeUpdating[projectId]
      // Patch the version in place from what the install actually left behind,
      // instead of re-probing every container just to refresh one row.
      const claude = s.claude
        ? {
            ...s.claude,
            containers: s.claude.containers.map((c) =>
              c.projectId === projectId && result.ok && result.version
                ? { projectId, installed: result.version }
                : c
            )
          }
        : s.claude
      return {
        claudeUpdating,
        claude,
        claudeResults: { ...s.claudeResults, [projectId]: result }
      }
    })
  },

  // Sequential on purpose: parallel npm installs would race the same registry
  // for no wall-clock win worth the noisier failure modes, and the rows read
  // better ticking over one at a time.
  updateClaudeAll: async () => {
    for (const id of behindIds(get().claude)) await get().updateClaudeIn(id)
  },

  setSharedOutput: async (folder) => {
    const config = await window.vivarium.setSharedOutput(folder)
    set({ config })
    await Promise.all([get().refreshOutputTree(), get().refreshStates()])
  },

  refreshOutputTree: async () => {
    set({ outputTree: await window.vivarium.outputTree() })
  },

  openOutputFile: (abs) => {
    void window.vivarium.openOutputFile(abs)
  },

  openOutputFolder: () => {
    void window.vivarium.openOutputFolder()
  },

  deleteOutputPath: async (abs) => {
    // Moves to the Recycle Bin (reversible). The fs.watch usually refreshes the
    // tree on its own, but refresh explicitly so the row disappears immediately.
    await window.vivarium.deleteOutputFile(abs)
    void get().refreshOutputTree()
  },

  toggleOutputDir: (path) =>
    set((s) => ({ outputExpanded: { ...s.outputExpanded, [path]: !s.outputExpanded[path] } })),

  toggleOutputPanel: () => set((s) => ({ outputCollapsed: !s.outputCollapsed })),
  // Clamp: never smaller than a few rows, never starving the project list —
  // the render-side maxHeight keeps it sane if the window shrinks afterwards.
  setOutputHeight: (n) =>
    set({ outputHeight: Math.max(96, Math.min(Math.round(window.innerHeight * 0.7), n)) }),

  setDiffBase: async (value) => {
    const config = await window.vivarium.setDiffBase(value)
    set({ config })
  },

  runProjectDiff: async (projectId) => {
    // Fire-and-forget; the output-folder watcher refreshes the tree when
    // changes.txt lands.
    await window.vivarium.projectDiff(projectId)
  },

  select: (sessionId) => {
    set((s) => {
      // ensure the owning project is expanded
      const proj = s.config.projects.find((p) => p.sessions.some((x) => x.id === sessionId))
      // opening a session acknowledges its finished-agent notification
      const notifications = { ...s.notifications }
      delete notifications[sessionId]
      return {
        selectedSessionId: sessionId,
        notifications,
        expanded: proj ? { ...s.expanded, [proj.id]: true } : s.expanded
      }
    })
    pushBadge(get().notifications, false)
  },

  toggle: (projectId) =>
    set((s) => ({ expanded: { ...s.expanded, [projectId]: !s.expanded[projectId] } })),

  setSidebarWidth: (n) => set({ sidebarWidth: Math.max(232, Math.min(460, n)) }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  zoomTerminal: (delta) =>
    set((s) => ({ terminalFontSize: Math.max(8, Math.min(32, s.terminalFontSize + delta)) })),
  resetTerminalZoom: () => set({ terminalFontSize: 13 }),
  setLive: (sessionId, live) => set((s) => ({ live: { ...s.live, [sessionId]: live } })),
  setActivity: (sessionId, a) => set((s) => ({ activity: { ...s.activity, [sessionId]: a } })),

  notifyAgentAttention: (sessionId, kind) => {
    // Only agent sessions get the "!" — host/container shells never do (a stray
    // hook event for a shell session, if one ever arrived, must not light one up).
    const proj = get().config.projects.find((p) => p.sessions.some((x) => x.id === sessionId))
    const sess = proj?.sessions.find((x) => x.id === sessionId)
    if (sess?.type !== 'agent') return
    const focused = document.hasFocus()
    // Already watching this session in a focused window → nothing to flag.
    if (focused && get().selectedSessionId === sessionId) return
    // A later Stop overwrites a stale question flag — latest state wins.
    set((s) => ({ notifications: { ...s.notifications, [sessionId]: kind } }))
    // Badge always shows the outstanding count; flashing is reserved for
    // events that arrive while the app is in the background.
    pushBadge(get().notifications, !focused)
  },

  handleAgentHook: (e) => {
    const s = get()
    // Ignore events for sessions that were killed while the turn was running.
    const exists = s.config.projects.some((p) => p.sessions.some((x) => x.id === e.sessionId))
    if (!exists) return
    if (e.kind === 'UserPromptSubmit') {
      s.setActivity(e.sessionId, 'working')
    } else if (e.kind === 'AskUserQuestion') {
      // Agent is blocked on a question. Activity stays 'working': the turn is
      // still in flight, and no hook fires when the question is answered, so
      // an 'idle' here would stick for the rest of the turn.
      s.notifyAgentAttention(e.sessionId, 'question')
    } else {
      s.setActivity(e.sessionId, 'idle')
      s.notifyAgentAttention(e.sessionId, 'finished')
    }
  },

  openAddProject: () => set({ dialog: 'addProject', ap: emptyDraft() }),

  openSettings: (projectId) => {
    const s = get()
    const p = s.config.projects.find((x) => x.id === projectId)
    if (!p) return
    const running = !!s.states[projectId]?.running
    set({
      dialog: 'settings',
      st: {
        id: p.id,
        name: p.name,
        basePath: p.basePath,
        mounts: [...p.mounts], // absolute paths; displayed relative in the dialog
        mountDraft: '',
        image: p.image,
        port: p.publishedPort ? String(p.publishedPort) : '',
        locked: running
      }
    })
  },

  openAddSession: (projectId, anchor) => {
    const p = get().config.projects.find((x) => x.id === projectId)
    // Keep the whole panel on screen: below the title bar, and clear of the
    // right/bottom edges by its own size (ADD_SESSION_POPOVER, so the two can't
    // drift apart).
    const { width, height } = ADD_SESSION_POPOVER
    const top = Math.max(40, Math.min(anchor.top, window.innerHeight - height - 8))
    const left = Math.min(anchor.right + 8, window.innerWidth - width - 16)
    const type = get().lastSessionType
    set({
      dialog: 'addSession',
      addSession: {
        projectId,
        top,
        left,
        type,
        name: defaultSessionName(p, type)
      }
    })
  },

  closeDialog: () =>
    set({
      dialog: null,
      addSession: null,
      killTarget: null,
      deleteTarget: null,
      st: null,
      claudeResults: {}
    }),

  // Main intercepted a window-close and is asking to confirm (see ipc.ts). Don't
  // clobber a dialog that's already open — a modal being up doesn't change that
  // the user wants to quit, and stacking over e.g. unsaved settings is fine.
  requestQuit: () => set({ dialog: 'confirmQuit' }),

  // User accepted the quit prompt: tell main to let the close through. Clearing
  // the dialog is cosmetic — the window is about to go away.
  confirmQuit: () => {
    set({ dialog: null })
    window.vivarium.confirmQuit()
  },

  setAp: (patch) => set((s) => ({ ap: { ...s.ap, ...patch } })),
  setSt: (patch) => set((s) => (s.st ? { st: { ...s.st, ...patch } } : {})),
  setAddSession: (patch) => set((s) => (s.addSession ? { addSession: { ...s.addSession, ...patch } } : {})),

  createProject: async () => {
    const { ap } = get()
    const config = await window.vivarium.createProject({
      name: ap.name,
      basePath: ap.basePath,
      // draft.mounts already hold absolute paths (converted at add-time)
      mounts: ap.mounts,
      image: ap.image,
      publishedPort: ap.image === 'full' ? parsePort(ap.port) : undefined
    })
    const created = config.projects[config.projects.length - 1]
    set((s) => ({
      config,
      dialog: null,
      expanded: { ...s.expanded, [created.id]: true }
    }))
    await get().refreshStates()
  },

  saveSettings: async () => {
    const { st, states } = get()
    if (!st) return
    const wasRunning = !!states[st.id]?.running
    const config = await window.vivarium.updateProject({
      id: st.id,
      name: st.name,
      basePath: st.basePath,
      mounts: st.mounts, // already absolute
      image: st.image,
      publishedPort: st.image === 'full' ? parsePort(st.port) : undefined
    })
    set({ config, dialog: null, st: null })
    // Settings changes only take effect on a fresh container. Recreate if it was
    // running so the new mounts/image/port apply immediately.
    if (wasRunning) {
      await window.vivarium.recreateContainer(st.id)
    }
    await get().refreshStates()
  },

  deleteProject: async (projectId) => {
    const config = await window.vivarium.deleteProject(projectId)
    set((s) => {
      // drop notifications for sessions that no longer exist
      const alive = new Set(config.projects.flatMap((p) => p.sessions.map((x) => x.id)))
      const notifications: Record<string, AttentionKind> = {}
      for (const id of Object.keys(s.notifications)) if (alive.has(id)) notifications[id] = s.notifications[id]
      return {
        config,
        notifications,
        selectedSessionId:
          s.selectedSessionId && !alive.has(s.selectedSessionId) ? null : s.selectedSessionId
      }
    })
    pushBadge(get().notifications, false)
    await get().refreshStates()
  },

  requestDeleteProject: (projectId, name) =>
    set({ dialog: 'confirmDeleteProject', deleteTarget: { id: projectId, name } }),

  confirmDeleteProject: async () => {
    const t = get().deleteTarget
    if (!t) return
    await get().deleteProject(t.id) // removes container + config + selection cleanup
    set({ dialog: null, deleteTarget: null, st: null })
  },

  openContextMenu: (x, y, items, onClose) => set({ contextMenu: { x, y, items, onClose } }),
  closeContextMenu: () => set({ contextMenu: null }),

  setDrag: (drag) => set({ drag }),
  setDropTarget: (dropTarget) => set({ dropTarget }),

  reorderProjects: async (orderedIds) => {
    const config = await window.vivarium.reorderProjects(orderedIds)
    set({ config, drag: null, dropTarget: null })
  },

  reorderSessions: async (projectId, orderedSessionIds) => {
    const config = await window.vivarium.reorderSessions(projectId, orderedSessionIds)
    set({ config, drag: null, dropTarget: null })
  },

  confirmAddSession: async () => {
    const { addSession, config } = get()
    if (!addSession) return
    const p = config.projects.find((x) => x.id === addSession.projectId)
    const name = addSession.name.trim() || defaultSessionName(p, addSession.type)
    const next = await window.vivarium.addSession(addSession.projectId, addSession.type, name)
    const proj = next.projects.find((x) => x.id === addSession.projectId)
    const created = proj?.sessions[proj.sessions.length - 1]
    set((s) => ({
      config: next,
      dialog: null,
      addSession: null,
      lastSessionType: addSession.type,
      selectedSessionId: created ? created.id : s.selectedSessionId,
      expanded: { ...s.expanded, [addSession.projectId]: true }
    }))
  },

  startRename: (sessionId, name) => set({ editingSessionId: sessionId, editDraft: name }),
  setEditDraft: (v) => set({ editDraft: v }),
  cancelRename: () => set({ editingSessionId: null }),
  commitRename: async (projectId) => {
    const { editingSessionId, editDraft } = get()
    if (!editingSessionId) return
    const config = await window.vivarium.renameSession(projectId, editingSessionId, editDraft)
    set({ config, editingSessionId: null })
  },

  requestKill: (projectId, sessionId, name) =>
    set({ dialog: 'confirmKill', killTarget: { projectId, sessionId, name } }),

  confirmKill: async () => {
    const { killTarget } = get()
    if (!killTarget) return
    const config = await window.vivarium.removeSession(killTarget.projectId, killTarget.sessionId)
    set((s) => {
      const stillExists = config.projects.some((p) =>
        p.sessions.some((x) => x.id === s.selectedSessionId)
      )
      const live = { ...s.live }
      delete live[killTarget.sessionId]
      const notifications = { ...s.notifications }
      delete notifications[killTarget.sessionId]
      return {
        config,
        dialog: null,
        killTarget: null,
        live,
        notifications,
        selectedSessionId: stillExists ? s.selectedSessionId : null
      }
    })
    pushBadge(get().notifications, false)
  },

  togglePower: async (projectId) => {
    if (get().containerOps[projectId]) return // an op is already in flight
    const running = !!get().states[projectId]?.running
    await get().runContainerOp(projectId, running ? 'stop' : 'start')
  },

  restart: async (projectId) => {
    if (get().containerOps[projectId]) return
    await get().runContainerOp(projectId, 'restart')
  },

  runContainerOp: async (projectId, op) => {
    // The in-flight op drives the amber pulsing square on the project row —
    // a cold start (image build, mounts) can take minutes, and without it the
    // only feedback was the 3s state poll eventually flipping the indicator.
    set((s) => {
      const containerErrors = { ...s.containerErrors }
      delete containerErrors[projectId]
      return { containerOps: { ...s.containerOps, [projectId]: op }, containerErrors }
    })
    try {
      if (op === 'stop') await window.vivarium.stopContainer(projectId)
      else if (op === 'start') await window.vivarium.startContainer(projectId)
      else await window.vivarium.restartContainer(projectId)
    } catch (err) {
      // ipcRenderer.invoke wraps the real message in boilerplate — strip it.
      const msg = String(err instanceof Error ? err.message : err).replace(
        /^Error invoking remote method '[^']*': (Error: )?/,
        ''
      )
      set((s) => ({ containerErrors: { ...s.containerErrors, [projectId]: msg } }))
      // Transient feedback, not persistent state: revert the red square to the
      // plain running/stopped indicator after a few seconds.
      setTimeout(() => {
        set((s) => {
          if (s.containerErrors[projectId] !== msg) return {}
          const containerErrors = { ...s.containerErrors }
          delete containerErrors[projectId]
          return { containerErrors }
        })
      }, 8000)
    } finally {
      set((s) => {
        const containerOps = { ...s.containerOps }
        delete containerOps[projectId]
        return { containerOps }
      })
      await get().refreshStates()
    }
  }
}))
