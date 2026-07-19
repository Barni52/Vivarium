import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/ipc'
import type {
  Config,
  ContainerState,
  DiffResult,
  DockerStatus,
  NewProjectInput,
  OutputNode,
  PtyDataEvent,
  PtyExitEvent,
  SessionType,
  SpawnResult,
  UpdateProjectInput
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

  // clipboard
  pasteImage: (projectId: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.pasteImage, projectId),
  clipboardReadText: (): Promise<string> => ipcRenderer.invoke(CH.clipboardReadText),
  clipboardWriteText: (text: string): void => ipcRenderer.send(CH.clipboardWriteText, text),

  // dialogs / window
  browseFolder: (): Promise<string | null> => ipcRenderer.invoke(CH.browseFolder),
  setBadge: (show: boolean): void => ipcRenderer.send(CH.setBadge, show),
  windowMinimize: (): void => ipcRenderer.send(CH.windowMinimize),
  windowMaximize: (): void => ipcRenderer.send(CH.windowMaximize),
  windowClose: (): void => ipcRenderer.send(CH.windowClose)
}

export type VivariumApi = typeof api

contextBridge.exposeInMainWorld('vivarium', api)
