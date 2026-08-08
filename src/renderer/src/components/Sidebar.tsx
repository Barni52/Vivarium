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
        background: 'var(--panel)',
        borderRight: '1px solid var(--border)',
        minHeight: 0,
        position: 'relative',
        fontSize: 12.5
      }}
    >
      <div style={{ padding: '10px 10px 8px 10px', flex: 'none' }}>
        <button
          onClick={openAddProject}
          onMouseEnter={() => setAddHover(true)}
          onMouseLeave={() => setAddHover(false)}
          style={{
            width: '100%',
            height: 38,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 14px',
            background: 'var(--accent)',
            color: 'var(--accent-fg)',
            border: 0,
            borderRadius: 'var(--radius)',
            fontSize: 12.5,
            fontWeight: 500,
            cursor: 'pointer',
            letterSpacing: '.2px',
            // Brightness, not a second blue. A filled button has one fill, and a
            // hover token for it would be a value that exists only to be 12%
            // lighter than another value — which is what `filter` already is.
            filter: addHover ? 'brightness(1.12)' : 'none',
            transition: 'filter .12s'
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
