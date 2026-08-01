import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpc } from './ipc'
import type { PtyManager } from './pty'
import type { ChatService } from './chat'

// Optional smoke-test hook: when VIVARIUM_CDP_PORT is set, expose the Chrome
// DevTools Protocol on that port and keep the window hidden so an automated
// check can confirm the renderer loaded without a visible window popping up.
const cdpPort = process.env['VIVARIUM_CDP_PORT']
if (cdpPort) {
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Dev/taskbar icon. Packaged builds get their icon from the exe (electron-
  // builder reads build/icon.ico), which isn't inside the asar, so guard it.
  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    frame: false, // custom title bar (see renderer/TitleBar)
    backgroundColor: '#0f141b',
    title: 'Vivarium',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  registerIpc(mainWindow)

  // The default menu is hidden (frame: false) but its accelerators still fire,
  // and they hijack keys terminals need — Ctrl+W (Close) would kill the window
  // instead of doing a word-delete, Ctrl+R (reload) would clobber shell reverse-
  // search, etc. Drop the menu entirely so every keystroke reaches the terminal.
  // Clipboard is handled in the renderer (TerminalView), not via menu roles.
  Menu.setApplicationMenu(null)

  // Menu removal also drops the DevTools accelerator, so keep F12 as a toggle
  // (unused by terminals, so no conflict) for debugging.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools()
  })

  mainWindow.on('ready-to-show', () => {
    if (!cdpPort) mainWindow?.show()
  })

  // electron-vite exposes the dev server URL in dev, the built file in prod.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// On quit: kill only local processes — never stop containers. A chat's CLI
// process is a `docker exec -i` client, so ending it costs exactly what ending a
// pty costs: an in-flight turn, and nothing else. The *conversation* is on the
// creds volume and comes back on the next open.
app.on('before-quit', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    const w = win as unknown as { __pty?: PtyManager; __chat?: ChatService }
    w.__pty?.killAll()
    w.__chat?.closeAll()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
