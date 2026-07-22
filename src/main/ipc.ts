import { ipcMain, dialog, BrowserWindow, clipboard, shell, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, mkdir } from 'node:fs/promises'
import { join, resolve, sep, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '@shared/ipc'
import type {
  BadgePayload,
  Config,
  ContainerState,
  DiffResult,
  DockerStatus,
  NewProjectInput,
  OutputNode,
  SessionType,
  SpawnResult,
  UpdateProjectInput
} from '@shared/types'
import { ConfigStore } from './config'
import { DockerService } from './docker'
import { BridgeWatcher, bridgeDir } from './bridge'
import { gitBranch, writeBranchDiff } from './git'
import { PtyManager } from './pty'
import { pasteImage } from './clipboard'
import { UsageService } from './usage'

export function registerIpc(win: BrowserWindow): void {
  const store = new ConfigStore()
  const docker = new DockerService()
  const emit = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const pty = new PtyManager(docker, emit)
  const usage = new UsageService(docker)

  // ---- claude plan usage --------------------------------------------------
  // Polled by the renderer (TitleBar chips); all token/HTTP logic lives in
  // UsageService.
  ipcMain.handle(CH.fetchUsage, () => usage.fetch())

  // Expose the pty manager for app-quit cleanup.
  ;(win as unknown as { __pty?: PtyManager }).__pty = pty

  // ---- agent hook bridge --------------------------------------------------
  // One watcher per project tails its bridge events.log (see bridge.ts) and
  // forwards Claude Code hook events to the renderer, which derives the
  // working/idle indicator and the agent-finished notification from them.
  const bridges = new Map<string, BridgeWatcher>()

  function syncBridgeWatchers(): void {
    const ids = new Set(store.get().projects.map((p) => p.id))
    for (const [id, w] of bridges) {
      if (!ids.has(id)) {
        w.close()
        bridges.delete(id)
      }
    }
    for (const id of ids) {
      if (!bridges.has(id)) {
        const w = new BridgeWatcher(bridgeDir(id), (e) => emit(CH.agentHook, e))
        bridges.set(id, w)
        void w.start()
      }
    }
  }

  // ---- config / projects / sessions -------------------------------------
  ipcMain.handle(CH.loadConfig, async (): Promise<Config> => {
    const cfg = await store.load()
    // Apply the persisted shared output folder to docker + start watching it.
    docker.setSharedOutput(cfg.sharedOutputFolder)
    startOutputWatcher()
    syncBridgeWatchers()
    return cfg
  })

  ipcMain.handle(CH.createProject, async (_e, input: NewProjectInput): Promise<Config> => {
    const id = randomUUID()
    const cfg = await store.mutate((cfg) => {
      cfg.projects.push({
        id,
        name: input.name.trim() || 'untitled-project',
        basePath: input.basePath,
        mounts: input.mounts,
        image: input.image,
        publishedPort: input.publishedPort,
        sessions: []
      })
      return cfg
    })
    syncBridgeWatchers()
    return cfg
  })

  ipcMain.handle(CH.updateProject, async (_e, input: UpdateProjectInput): Promise<Config> => {
    const project = store.getProject(input.id)
    const running = project ? await docker.isRunning(project) : false
    return store.mutate((cfg) => {
      const p = cfg.projects.find((x) => x.id === input.id)
      if (!p) return cfg
      p.name = input.name.trim() || p.name
      p.basePath = input.basePath
      p.image = input.image
      p.publishedPort = input.publishedPort
      // Mounts may only change while the container is stopped.
      if (!running) p.mounts = input.mounts
      return cfg
    })
  })

  ipcMain.handle(CH.deleteProject, async (_e, id: string): Promise<Config> => {
    const project = store.getProject(id)
    if (project) {
      for (const s of project.sessions) pty.kill(s.id)
      await docker.remove(project)
    }
    const cfg = await store.mutate((cfg) => {
      cfg.projects = cfg.projects.filter((p) => p.id !== id)
      return cfg
    })
    syncBridgeWatchers()
    return cfg
  })

  ipcMain.handle(
    CH.addSession,
    async (_e, projectId: string, type: SessionType, name: string): Promise<Config> => {
      const id = randomUUID()
      return store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        if (p) p.sessions.push({ id, name, type })
        return cfg
      })
    }
  )

  ipcMain.handle(
    CH.renameSession,
    async (_e, projectId: string, sessionId: string, name: string): Promise<Config> => {
      return store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        const s = p?.sessions.find((x) => x.id === sessionId)
        if (s && name.trim()) s.name = name.trim()
        return cfg
      })
    }
  )

  ipcMain.handle(
    CH.removeSession,
    async (_e, projectId: string, sessionId: string): Promise<Config> => {
      pty.kill(sessionId)
      return store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        if (p) p.sessions = p.sessions.filter((s) => s.id !== sessionId)
        return cfg
      })
    }
  )

  ipcMain.handle(CH.reorderProjects, async (_e, orderedIds: string[]): Promise<Config> => {
    return store.mutate((cfg) => {
      const byId = new Map(cfg.projects.map((p) => [p.id, p]))
      const reordered = orderedIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
      // keep any projects not present in the ordered list (safety) appended in original order
      for (const p of cfg.projects) if (!orderedIds.includes(p.id)) reordered.push(p)
      cfg.projects = reordered
      return cfg
    })
  })

  ipcMain.handle(
    CH.reorderSessions,
    async (_e, projectId: string, orderedSessionIds: string[]): Promise<Config> => {
      return store.mutate((cfg) => {
        const p = cfg.projects.find((x) => x.id === projectId)
        if (!p) return cfg
        const byId = new Map(p.sessions.map((s) => [s.id, s]))
        const reordered = orderedSessionIds
          .map((id) => byId.get(id))
          .filter((s): s is NonNullable<typeof s> => !!s)
        for (const s of p.sessions) if (!orderedSessionIds.includes(s.id)) reordered.push(s)
        p.sessions = reordered
        return cfg
      })
    }
  )

  // ---- git ---------------------------------------------------------------
  ipcMain.handle(CH.projectBranches, async (): Promise<Record<string, string | null>> => {
    const out: Record<string, string | null> = {}
    for (const p of store.get().projects) out[p.id] = gitBranch(p.basePath)
    return out
  })

  ipcMain.handle(CH.projectDiff, async (_e, projectId: string): Promise<DiffResult> => {
    const cfg = store.get()
    const p = cfg.projects.find((x) => x.id === projectId)
    if (!p) return { ok: false, message: 'not-found' }
    if (!cfg.sharedOutputFolder) return { ok: false, message: 'no-output' }
    return writeBranchDiff(p, cfg.sharedOutputFolder, cfg.diffBase || 'origin/master')
  })

  ipcMain.handle(CH.setDiffBase, async (_e, value: string): Promise<Config> => {
    return store.mutate((cfg) => {
      cfg.diffBase = value.trim() || undefined
      return cfg
    })
  })

  // ---- docker / containers ----------------------------------------------
  ipcMain.handle(CH.dockerStatus, async (): Promise<DockerStatus> => {
    const bin = await docker.binaryName()
    return {
      available: !!bin,
      binary: bin,
      message: bin ? undefined : 'docker not found on PATH — start Docker/Rancher Desktop'
    }
  })

  ipcMain.handle(CH.containerStates, async (): Promise<ContainerState[]> => {
    const cfg = store.get()
    const out: ContainerState[] = []
    for (const p of cfg.projects) {
      out.push({
        projectId: p.id,
        running: await docker.isRunning(p),
        exists: await docker.containerExists(p)
      })
    }
    return out
  })

  const sinkFor = (projectId: string) => (data: string): void =>
    emit(CH.containerOutput, { projectId, data })

  ipcMain.handle(CH.startContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    const ok = await docker.start(p, sinkFor(projectId))
    emit(CH.containerStateChanged, { projectId, running: ok })
    return ok
  })

  ipcMain.handle(CH.stopContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    await docker.stop(p)
    emit(CH.containerStateChanged, { projectId, running: false })
    return true
  })

  ipcMain.handle(CH.restartContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    const ok = await docker.restart(p, sinkFor(projectId))
    emit(CH.containerStateChanged, { projectId, running: ok })
    return ok
  })

  ipcMain.handle(CH.recreateContainer, async (_e, projectId: string): Promise<boolean> => {
    const p = store.getProject(projectId)
    if (!p) return false
    const ok = await docker.recreate(p, sinkFor(projectId))
    emit(CH.containerStateChanged, { projectId, running: ok })
    return ok
  })

  // ---- shared output folder ---------------------------------------------
  let outputWatcher: FSWatcher | null = null
  let watchDebounce: ReturnType<typeof setTimeout> | null = null

  function startOutputWatcher(): void {
    if (outputWatcher) {
      try {
        outputWatcher.close()
      } catch {
        /* already closed */
      }
      outputWatcher = null
    }
    const folder = store.get().sharedOutputFolder
    if (!folder) return
    try {
      // recursive watch is supported on Windows; debounce to coalesce bursts.
      outputWatcher = watch(folder, { recursive: true }, () => {
        if (watchDebounce) clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => emit(CH.outputChanged, {}), 200)
      })
    } catch {
      outputWatcher = null // folder missing / not watchable
    }
  }

  async function scanTree(dir: string, depth: number): Promise<OutputNode[]> {
    if (depth > 8) return [] // guard against pathological nesting
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
    const dirs = entries.filter((e) => e.isDirectory()).sort(byName)
    const files = entries.filter((e) => e.isFile()).sort(byName)
    const out: OutputNode[] = []
    for (const d of dirs) {
      const p = join(dir, d.name)
      out.push({ name: d.name, path: p, type: 'dir', children: await scanTree(p, depth + 1) })
    }
    for (const f of files) {
      out.push({ name: f.name, path: join(dir, f.name), type: 'file' })
    }
    return out
  }

  ipcMain.handle(CH.setSharedOutput, async (_e, folder: string | null): Promise<Config> => {
    const next = await store.mutate((cfg) => {
      cfg.sharedOutputFolder = folder || undefined
      return cfg
    })
    docker.setSharedOutput(next.sharedOutputFolder)
    if (next.sharedOutputFolder) {
      await mkdir(next.sharedOutputFolder, { recursive: true }).catch(() => {})
    }
    startOutputWatcher()
    // Auto-recreate running containers so the new mount applies immediately.
    for (const p of next.projects) {
      if (await docker.isRunning(p)) {
        const ok = await docker.recreate(p, sinkFor(p.id))
        emit(CH.containerStateChanged, { projectId: p.id, running: ok })
      }
    }
    return next
  })

  ipcMain.handle(CH.outputTree, async (): Promise<OutputNode[]> => {
    const folder = store.get().sharedOutputFolder
    return folder ? scanTree(folder, 0) : []
  })

  ipcMain.handle(CH.openOutputFile, async (_e, abs: string): Promise<string> => {
    const folder = store.get().sharedOutputFolder
    if (!folder) return 'no-folder'
    const root = resolve(folder)
    const target = resolve(abs)
    // Only allow opening files inside the shared folder (reject traversal).
    if (target !== root && !target.startsWith(root + sep)) return 'outside'
    const ext = extname(target).toLowerCase()
    if (ext === '.html' || ext === '.htm') {
      await shell.openExternal(pathToFileURL(target).href) // force default browser
      return ''
    }
    return shell.openPath(target) // OS default app; '' on success
  })

  ipcMain.handle(CH.deleteOutputFile, async (_e, abs: string): Promise<string> => {
    const folder = store.get().sharedOutputFolder
    if (!folder) return 'no-folder'
    const root = resolve(folder)
    const target = resolve(abs)
    // Must be strictly inside the shared folder — never delete the root itself,
    // never allow traversal outside it.
    if (target === root) return 'is-root'
    if (!target.startsWith(root + sep)) return 'outside'
    // Recycle Bin, not permanent unlink: reversible, and handles non-empty dirs.
    // The recursive fs.watch fires outputChanged → the tree refreshes itself.
    try {
      await shell.trashItem(target)
      return ''
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })

  // ---- pty / sessions ----------------------------------------------------
  ipcMain.handle(
    CH.openSession,
    async (
      _e,
      projectId: string,
      sessionId: string,
      cols: number,
      rows: number
    ): Promise<SpawnResult> => {
      const p = store.getProject(projectId)
      const s = p?.sessions.find((x) => x.id === sessionId)
      if (!p || !s) return { ok: false, reason: 'not-found' }

      // Already live → just re-attach (renderer keeps the xterm).
      if (pty.has(sessionId)) return { ok: true }

      if (s.type !== 'host-shell') {
        if (!(await docker.binaryName())) {
          return { ok: false, reason: 'docker-missing', message: 'docker not found on PATH' }
        }
        // Opening a session must NOT start a stopped container — starting is an
        // explicit action via the project power control. If the container isn't
        // running, tell the renderer to show the "start the container"
        // placeholder instead of spawning (which would auto-start it).
        if (!(await docker.isRunning(p))) {
          return { ok: false, reason: 'container-stopped' }
        }
      }

      const ok = await pty.spawn(s, p, cols, rows)
      return ok ? { ok: true } : { ok: false, reason: 'spawn-failed' }
    }
  )

  ipcMain.on(CH.writeSession, (_e, sessionId: string, data: string) => pty.write(sessionId, data))
  ipcMain.on(CH.resizeSession, (_e, sessionId: string, cols: number, rows: number) =>
    pty.resize(sessionId, cols, rows)
  )
  ipcMain.on(CH.killSession, (_e, sessionId: string) => pty.kill(sessionId))

  // ---- clipboard ---------------------------------------------------------
  ipcMain.handle(CH.pasteImage, async (_e, projectId: string): Promise<string | null> =>
    pasteImage(projectId)
  )
  ipcMain.handle(CH.clipboardReadText, (): string => clipboard.readText())
  ipcMain.on(CH.clipboardWriteText, (_e, text: string) => clipboard.writeText(text))

  // ---- dialogs / window --------------------------------------------------
  ipcMain.handle(CH.browseFolder, async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.on(CH.windowMinimize, () => win.minimize())
  ipcMain.on(CH.windowMaximize, () => (win.isMaximized() ? win.unmaximize() : win.maximize()))
  ipcMain.on(CH.windowClose, () => win.close())

  // ---- taskbar attention badge (agents finished / asking, with count) ----
  // The renderer draws the count disc on a canvas (main has no canvas) and
  // ships it as a data URL. The overlay mirrors the outstanding-notification
  // count — it clears when every flagged session has been viewed (count 0),
  // NOT on window focus, so the number stays glanceable while working.
  // flashFrame(true) flashes until focus with no built-in duration, so a timer
  // stops it after a few seconds (Discord-style burst) — only the flashing is
  // time-limited.
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  const stopFlash = (): void => {
    if (flashTimer) {
      clearTimeout(flashTimer)
      flashTimer = null
    }
    if (!win.isDestroyed()) win.flashFrame(false)
  }
  ipcMain.on(CH.setBadge, (_e, b: BadgePayload) => {
    if (win.isDestroyed()) return
    win.setOverlayIcon(
      b.dataUrl ? nativeImage.createFromDataURL(b.dataUrl) : null,
      b.count > 0 ? `${b.count} agent session${b.count === 1 ? '' : 's'} need attention` : ''
    )
    if (b.flash) {
      // Discord-style attention flash — Windows FlashWindowEx (built-in).
      win.flashFrame(true)
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(stopFlash, 4000)
    } else if (b.count === 0) {
      stopFlash()
    }
  })
  win.on('focus', () => {
    stopFlash() // stop flashing once the user looks at the app; the count stays
  })
}
