// Channel names shared between preload and main. The renderer never uses these
// directly — it goes through the typed `window.vivarium` API from the preload.

export const CH = {
  // config / projects / sessions
  loadConfig: 'config:load',
  createProject: 'project:create',
  updateProject: 'project:update',
  deleteProject: 'project:delete',
  addSession: 'session:add',
  renameSession: 'session:rename',
  removeSession: 'session:remove',
  reorderProjects: 'project:reorder',
  reorderSessions: 'session:reorder',

  // git
  projectBranches: 'git:branches',
  projectDiff: 'git:diff',
  setDiffBase: 'git:set-diff-base',

  // shared output folder
  setSharedOutput: 'output:set-folder',
  outputTree: 'output:tree',
  openOutputFile: 'output:open-file',
  openOutputFolder: 'output:open-folder',
  deleteOutputFile: 'output:delete-file',
  outputChanged: 'output:changed',

  // docker / containers
  dockerStatus: 'docker:status',
  containerStates: 'container:states',
  startContainer: 'container:start',
  stopContainer: 'container:stop',
  restartContainer: 'container:restart',
  recreateContainer: 'container:recreate',

  // pty / sessions
  openSession: 'pty:open',
  writeSession: 'pty:write',
  resizeSession: 'pty:resize',
  killSession: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  containerOutput: 'container:output',
  containerStateChanged: 'container:state-changed',
  agentHook: 'agent:hook',

  // clipboard
  pasteImage: 'clipboard:paste-image',
  clipboardReadText: 'clipboard:read-text',
  clipboardWriteText: 'clipboard:write-text',

  // claude plan usage
  fetchUsage: 'usage:fetch',

  // dialogs / window
  browseFolder: 'dialog:browse-folder',
  setBadge: 'window:set-badge',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  // Confirm-on-quit handshake: main intercepts every close path and emits
  // quitRequested; the renderer shows its dialog and sends confirmQuit back once
  // the user accepts, which lets the real close through.
  quitRequested: 'window:quit-requested',
  confirmQuit: 'window:confirm-quit'
} as const
