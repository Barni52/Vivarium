import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/ipc'
import type {
  AgentActivityEvent,
  AppInfo,
  BadgePayload,
  ChatAnswer,
  ChatAttachment,
  ChatEntry,
  ChatEvent,
  ChatMode,
  ChatOpenResult,
  ClaudeStatus,
  ClaudeUpdateResult,
  Config,
  ContainerState,
  DiffResult,
  DockerStatus,
  MountNode,
  NewProjectInput,
  OutputNode,
  PtyDataEvent,
  PtyExitEvent,
  SessionType,
  SpawnResult,
  UpdateProjectInput,
  UsageSnapshot,
  VolumeRemoveResult,
  VolumeReport
} from '../shared/types'

export interface ContainerOutputEvent {
  projectId: string
  data: string
}

export interface ContainerStateChangedEvent {
  projectId: string
  running: boolean
}

const api = {
  // config / projects / sessions
  loadConfig: (): Promise<Config> => ipcRenderer.invoke(CH.loadConfig),
  createProject: (input: NewProjectInput): Promise<Config> =>
    ipcRenderer.invoke(CH.createProject, input),
  updateProject: (input: UpdateProjectInput): Promise<Config> =>
    ipcRenderer.invoke(CH.updateProject, input),
  deleteProject: (id: string): Promise<Config> => ipcRenderer.invoke(CH.deleteProject, id),
  addSession: (projectId: string, type: SessionType, name: string): Promise<Config> =>
    ipcRenderer.invoke(CH.addSession, projectId, type, name),
  renameSession: (projectId: string, sessionId: string, name: string): Promise<Config> =>
    ipcRenderer.invoke(CH.renameSession, projectId, sessionId, name),
  removeSession: (projectId: string, sessionId: string): Promise<Config> =>
    ipcRenderer.invoke(CH.removeSession, projectId, sessionId),
  reorderProjects: (orderedIds: string[]): Promise<Config> =>
    ipcRenderer.invoke(CH.reorderProjects, orderedIds),
  reorderSessions: (projectId: string, orderedSessionIds: string[]): Promise<Config> =>
    ipcRenderer.invoke(CH.reorderSessions, projectId, orderedSessionIds),
  // index = insertion point in the target project's session list; -1 appends.
  moveSession: (
    fromProjectId: string,
    toProjectId: string,
    sessionId: string,
    index: number
  ): Promise<Config> =>
    ipcRenderer.invoke(CH.moveSession, fromProjectId, toProjectId, sessionId, index),

  // git
  projectBranches: (): Promise<Record<string, string | null>> =>
    ipcRenderer.invoke(CH.projectBranches),
  projectDiff: (projectId: string): Promise<DiffResult> =>
    ipcRenderer.invoke(CH.projectDiff, projectId),
  setDiffBase: (value: string): Promise<Config> => ipcRenderer.invoke(CH.setDiffBase, value),

  // shared output folder
  setSharedOutput: (folder: string | null): Promise<Config> =>
    ipcRenderer.invoke(CH.setSharedOutput, folder),
  outputTree: (): Promise<OutputNode[]> => ipcRenderer.invoke(CH.outputTree),
  openOutputFile: (abs: string): Promise<string> => ipcRenderer.invoke(CH.openOutputFile, abs),
  openOutputFolder: (): Promise<string> => ipcRenderer.invoke(CH.openOutputFolder),
  deleteOutputFile: (abs: string): Promise<string> => ipcRenderer.invoke(CH.deleteOutputFile, abs),
  onOutputChanged: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on(CH.outputChanged, h)
    return () => ipcRenderer.removeListener(CH.outputChanged, h)
  },

  // docker / containers
  dockerStatus: (): Promise<DockerStatus> => ipcRenderer.invoke(CH.dockerStatus),
  containerStates: (): Promise<ContainerState[]> => ipcRenderer.invoke(CH.containerStates),
  startContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.startContainer, projectId),
  stopContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.stopContainer, projectId),
  restartContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.restartContainer, projectId),
  recreateContainer: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.recreateContainer, projectId),

  // volume housekeeping (slow: listing measures every volume on disk)
  volumes: (): Promise<VolumeReport> => ipcRenderer.invoke(CH.volumes),
  removeVolume: (name: string): Promise<VolumeRemoveResult> =>
    ipcRenderer.invoke(CH.removeVolume, name),

  // pty / sessions
  openSession: (
    projectId: string,
    sessionId: string,
    cols: number,
    rows: number
  ): Promise<SpawnResult> => ipcRenderer.invoke(CH.openSession, projectId, sessionId, cols, rows),
  writeSession: (sessionId: string, data: string): void =>
    ipcRenderer.send(CH.writeSession, sessionId, data),
  resizeSession: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send(CH.resizeSession, sessionId, cols, rows),
  killSession: (sessionId: string): void => ipcRenderer.send(CH.killSession, sessionId),

  onPtyData: (cb: (e: PtyDataEvent) => void): (() => void) => {
    const h = (_: unknown, p: PtyDataEvent): void => cb(p)
    ipcRenderer.on(CH.ptyData, h)
    return () => ipcRenderer.removeListener(CH.ptyData, h)
  },
  onPtyExit: (cb: (e: PtyExitEvent) => void): (() => void) => {
    const h = (_: unknown, p: PtyExitEvent): void => cb(p)
    ipcRenderer.on(CH.ptyExit, h)
    return () => ipcRenderer.removeListener(CH.ptyExit, h)
  },
  onContainerOutput: (cb: (e: ContainerOutputEvent) => void): (() => void) => {
    const h = (_: unknown, p: ContainerOutputEvent): void => cb(p)
    ipcRenderer.on(CH.containerOutput, h)
    return () => ipcRenderer.removeListener(CH.containerOutput, h)
  },
  onContainerStateChanged: (cb: (e: ContainerStateChangedEvent) => void): (() => void) => {
    const h = (_: unknown, p: ContainerStateChangedEvent): void => cb(p)
    ipcRenderer.on(CH.containerStateChanged, h)
    return () => ipcRenderer.removeListener(CH.containerStateChanged, h)
  },
  // Both producers — the hook bridge for pty agents, the stream reader for chat.
  onAgentActivity: (cb: (e: AgentActivityEvent) => void): (() => void) => {
    const h = (_: unknown, p: AgentActivityEvent): void => cb(p)
    ipcRenderer.on(CH.agentActivity, h)
    return () => ipcRenderer.removeListener(CH.agentActivity, h)
  },

  // chat sessions
  chatOpen: (projectId: string, sessionId: string, retry = false): Promise<ChatOpenResult> =>
    ipcRenderer.invoke(CH.chatOpen, projectId, sessionId, retry),
  chatSend: (sessionId: string, text: string, attachments: ChatAttachment[]): Promise<boolean> =>
    ipcRenderer.invoke(CH.chatSend, sessionId, text, attachments),
  chatInterrupt: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(CH.chatInterrupt, sessionId),
  chatAnswer: (sessionId: string, requestId: string, answer: ChatAnswer): Promise<void> =>
    ipcRenderer.invoke(CH.chatAnswer, sessionId, requestId, answer),
  chatSetMode: (sessionId: string, mode: ChatMode): Promise<Config> =>
    ipcRenderer.invoke(CH.chatSetMode, sessionId, mode),
  chatSetModel: (sessionId: string, model: string): Promise<Config> =>
    ipcRenderer.invoke(CH.chatSetModel, sessionId, model),
  chatModels: (sessionId: string): Promise<string[]> => ipcRenderer.invoke(CH.chatModels, sessionId),
  chatClose: (sessionId: string): void => ipcRenderer.send(CH.chatClose, sessionId),
  chatBody: (sessionId: string, entryId: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.chatBody, sessionId, entryId),
  chatEarlier: (
    sessionId: string,
    mounted: number
  ): Promise<{ entries: ChatEntry[]; total: number }> =>
    ipcRenderer.invoke(CH.chatEarlier, sessionId, mounted),
  chatSubagent: (
    sessionId: string,
    toolUseId: string,
    agentId: string | null
  ): Promise<ChatEntry[]> => ipcRenderer.invoke(CH.chatSubagent, sessionId, toolUseId, agentId),
  chatMountTree: (projectId: string): Promise<MountNode[]> =>
    ipcRenderer.invoke(CH.chatMountTree, projectId),
  // The one union channel — see the ChatEvent doc comment for why it is one.
  onChatEvent: (cb: (e: ChatEvent) => void): (() => void) => {
    const h = (_: unknown, p: ChatEvent): void => cb(p)
    ipcRenderer.on(CH.chatEvent, h)
    return () => ipcRenderer.removeListener(CH.chatEvent, h)
  },

  // clipboard
  pasteImage: (projectId: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.pasteImage, projectId),
  clipboardReadText: (): Promise<string> => ipcRenderer.invoke(CH.clipboardReadText),
  clipboardWriteText: (text: string): void => ipcRenderer.send(CH.clipboardWriteText, text),

  // dialogs / window
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CH.appInfo),
  browseFolder: (): Promise<string | null> => ipcRenderer.invoke(CH.browseFolder),
  fetchUsage: (): Promise<UsageSnapshot> => ipcRenderer.invoke(CH.fetchUsage),

  // claude code version / manual update (force skips main's npm-registry cache)
  claudeStatus: (force = false): Promise<ClaudeStatus> =>
    ipcRenderer.invoke(CH.claudeStatus, force),
  claudeUpdate: (projectId: string): Promise<ClaudeUpdateResult> =>
    ipcRenderer.invoke(CH.claudeUpdate, projectId),

  setBadge: (b: BadgePayload): void => ipcRenderer.send(CH.setBadge, b),
  windowMinimize: (): void => ipcRenderer.send(CH.windowMinimize),
  windowMaximize: (): void => ipcRenderer.send(CH.windowMaximize),
  windowClose: (): void => ipcRenderer.send(CH.windowClose),
  // Confirm-on-quit: main asks (quitRequested), renderer confirms (confirmQuit).
  onQuitRequested: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on(CH.quitRequested, h)
    return () => ipcRenderer.removeListener(CH.quitRequested, h)
  },
  // The window became the active one (taskbar/start-menu click, alt-tab, restore).
  onWindowFocused: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on(CH.windowFocused, h)
    return () => ipcRenderer.removeListener(CH.windowFocused, h)
  },
  confirmQuit: (): void => ipcRenderer.send(CH.confirmQuit)
}

export type VivariumApi = typeof api

contextBridge.exposeInMainWorld('vivarium', api)
