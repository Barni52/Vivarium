import React from 'react'
import { useStore } from '../state/store'
import { Plus } from './Icons'
import { ProjectRow } from './ProjectRow'
import { OutputPanel } from './OutputPanel'

export function Sidebar(): React.ReactElement {
  const width = useStore((s) => s.sidebarWidth)
  const projects = useStore((s) => s.config.projects)
  const openAddProject = useStore((s) => s.openAddProject)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const [addHover, setAddHover] = React.useState(false)

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent): void => setSidebarWidth(startW + (ev.clientX - startX))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div
      style={{
        width,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--border-2)',
        minHeight: 0,
        position: 'relative'
      }}
    >
      <div style={{ padding: '12px 12px 8px 12px', flex: 'none' }}>
        <button
          onClick={openAddProject}
          onMouseEnter={() => setAddHover(true)}
          onMouseLeave={() => setAddHover(false)}
          style={{
            width: '100%',
            height: 40,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 14px',
            background: addHover ? 'var(--accent-2)' : 'var(--accent)',
            color: '#fff',
            border: 0,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            letterSpacing: '.2px'
          }}
        >
          <Plus size={16} />
          Add project
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '2px 0 8px 0' }}>
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </div>

      {/* shared output folder + file tree */}
      <OutputPanel />

      {/* resize handle */}
      <div
        onMouseDown={startResize}
        style={{ position: 'absolute', top: 0, right: -3, width: 6, height: '100%', cursor: 'col-resize', zIndex: 5 }}
      />
    </div>
  )
}
