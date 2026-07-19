import { create } from 'zustand'
import type {
  Config,
  ContainerState,
  DockerStatus,
  ImageVariant,
  OutputNode,
  Project,
  SessionType,
  AgentActivity
} from '@shared/types'

export type DialogKind =
  | 'addProject'
  | 'settings'
  | 'addSession'
  | 'confirmKill'
  | 'confirmDeleteProject'
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
  selectedSessionId: string | null
  expanded: Record<string, boolean>
  sidebarWidth: number
  sidebarCollapsed: boolean
  terminalFontSize: number
  /** session ids that currently have a live pty */
  live: Record<string, boolean>
  activity: Record<string, AgentActivity>

  dialog: DialogKind
  ap: ProjectDraft
  st: SettingsDraft | null
  addSession: AddSessionDraft | null
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

  // shared output folder
  setSharedOutput: (folder: string | null) => Promise<void>
  refreshOutputTree: () => Promise<void>
  openOutputFile: (abs: string) => void
  toggleOutputDir: (path: string) => void
  toggleOutputPanel: () => void

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

  // dialogs
  openAddProject: () => void
  openSettings: (projectId: string) => void
  openAddSession: (projectId: string, anchor: DOMRect) => void
  closeDialog: () => void
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
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void
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
}

const emptyDraft = (): ProjectDraft => ({
  name: '',
  basePath: '',
  mounts: [],
  mountDraft: '',
  image: 'slim',
  port: ''
})

function defaultSessionName(project: Project | undefined, type: SessionType): string {
  const base = type === 'agent' ? 'agent' : type === 'container-shell' ? 'bash' : 'ps-host'
  const n = (project?.sessions.filter((s) => s.type === type).length ?? 0) + 1
  return `${base}-${n}`
}

function parsePort(v: string): number | undefined {
  const n = parseInt(v.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export const useStore = create<AppState>((set, get) => ({
  config: { version: 1, projects: [] },
  states: {},
  branches: {},
  docker: null,
  outputTree: [],
  outputExpanded: {},
  outputCollapsed: false,
  selectedSessionId: null,
  expanded: {},
  sidebarWidth: 292,
  sidebarCollapsed: false,
  terminalFontSize: 13,
  live: {},
  activity: {},
  dialog: null,
  ap: emptyDraft(),
  st: null,
  addSession: null,
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

  toggleOutputDir: (path) =>
    set((s) => ({ outputExpanded: { ...s.outputExpanded, [path]: !s.outputExpanded[path] } })),

  toggleOutputPanel: () => set((s) => ({ outputCollapsed: !s.outputCollapsed })),

  setDiffBase: async (value) => {
    const config = await window.vivarium.setDiffBase(value)
    set({ config })
  },

  runProjectDiff: async (projectId) => {
    // Fire-and-forget; the output-folder watcher refreshes the tree when
    // changes.txt lands.
    await window.vivarium.projectDiff(projectId)
  },

  select: (sessionId) =>
    set((s) => {
      // ensure the owning project is expanded
      const proj = s.config.projects.find((p) => p.sessions.some((x) => x.id === sessionId))
      return {
        selectedSessionId: sessionId,
        expanded: proj ? { ...s.expanded, [proj.id]: true } : s.expanded
      }
    }),

  toggle: (projectId) =>
    set((s) => ({ expanded: { ...s.expanded, [projectId]: !s.expanded[projectId] } })),

  setSidebarWidth: (n) => set({ sidebarWidth: Math.max(232, Math.min(460, n)) }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  zoomTerminal: (delta) =>
    set((s) => ({ terminalFontSize: Math.max(8, Math.min(32, s.terminalFontSize + delta)) })),
  resetTerminalZoom: () => set({ terminalFontSize: 13 }),
  setLive: (sessionId, live) => set((s) => ({ live: { ...s.live, [sessionId]: live } })),
  setActivity: (sessionId, a) => set((s) => ({ activity: { ...s.activity, [sessionId]: a } })),

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
    const top = Math.max(40, Math.min(anchor.top, window.innerHeight - 380))
    const left = Math.min(anchor.right + 8, window.innerWidth - 316)
    set({
      dialog: 'addSession',
      addSession: {
        projectId,
        top,
        left,
        type: 'agent',
        name: defaultSessionName(p, 'agent')
      }
    })
  },

  closeDialog: () =>
    set({ dialog: null, addSession: null, killTarget: null, deleteTarget: null, st: null }),

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
    set((s) => ({
      config,
      selectedSessionId:
        s.selectedSessionId &&
        !config.projects.some((p) => p.sessions.some((x) => x.id === s.selectedSessionId))
          ? null
          : s.selectedSessionId
    }))
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

  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
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
      return {
        config,
        dialog: null,
        killTarget: null,
        live,
        selectedSessionId: stillExists ? s.selectedSessionId : null
      }
    })
  },

  togglePower: async (projectId) => {
    const running = !!get().states[projectId]?.running
    if (running) {
      await window.vivarium.stopContainer(projectId)
    } else {
      await window.vivarium.startContainer(projectId)
    }
    await get().refreshStates()
  },

  restart: async (projectId) => {
    await window.vivarium.restartContainer(projectId)
    await get().refreshStates()
  }
}))
