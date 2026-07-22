import React from 'react'
import { useStore } from './state/store'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { TerminalHost } from './components/TerminalHost'
import { AddProject } from './components/dialogs/AddProject'
import { ProjectSettings } from './components/dialogs/ProjectSettings'
import { AddSessionPopover } from './components/dialogs/AddSessionPopover'
import { ConfirmKill } from './components/dialogs/ConfirmKill'
import { ConfirmDeleteProject } from './components/dialogs/ConfirmDeleteProject'
import { ConfirmQuit } from './components/dialogs/ConfirmQuit'
import { ContextMenu } from './components/ContextMenu'

export function App(): React.ReactElement {
  const init = useStore((s) => s.init)
  const refreshStates = useStore((s) => s.refreshStates)
  const refreshBranches = useStore((s) => s.refreshBranches)
  const refreshUsage = useStore((s) => s.refreshUsage)
  const refreshOutputTree = useStore((s) => s.refreshOutputTree)
  const handleAgentHook = useStore((s) => s.handleAgentHook)
  const requestQuit = useStore((s) => s.requestQuit)
  const dialog = useStore((s) => s.dialog)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)

  React.useEffect(() => {
    // debug handle for automated smoke tests / DevTools inspection
    ;(window as unknown as { __vivStore?: typeof useStore }).__vivStore = useStore
    init()
    // keep the running/stopped indicators + git branches fresh
    const poll = setInterval(() => {
      refreshStates()
      refreshBranches()
    }, 3000)
    // Plan usage: the endpoint allows ~5 requests per 5 minutes (measured
    // 2026-07-22; tripping it = ~5 min lockout), so poll every 3 minutes —
    // two per window, leaving headroom for this startup fetch and restarts.
    // Between syncs the TitleBar countdown interpolates off the app clock.
    refreshUsage()
    const usagePoll = setInterval(() => refreshUsage(), 180_000)
    const off = window.vivarium.onContainerStateChanged(() => refreshStates())
    const offOutput = window.vivarium.onOutputChanged(() => refreshOutputTree())
    const offHook = window.vivarium.onAgentHook((e) => handleAgentHook(e))
    // Main intercepts every window-close path and asks us to confirm first.
    const offQuit = window.vivarium.onQuitRequested(() => requestQuit())
    return () => {
      clearInterval(poll)
      clearInterval(usagePoll)
      off()
      offOutput()
      offHook()
      offQuit()
    }
  }, [init, refreshStates, refreshBranches, refreshOutputTree, refreshUsage, handleAgentHook, requestQuit])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        fontSize: 14,
        overflow: 'hidden',
        position: 'relative',
        lineHeight: 1.45
      }}
    >
      <TitleBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!sidebarCollapsed && <Sidebar />}
        <TerminalHost />
      </div>

      {dialog === 'addProject' && <AddProject />}
      {dialog === 'settings' && <ProjectSettings />}
      {dialog === 'addSession' && <AddSessionPopover />}
      {dialog === 'confirmKill' && <ConfirmKill />}
      {dialog === 'confirmDeleteProject' && <ConfirmDeleteProject />}
      {dialog === 'confirmQuit' && <ConfirmQuit />}
      <ContextMenu />
    </div>
  )
}
