import React from 'react'
import { useStore } from '../state/store'
import { leaf } from '../paths'
import { Chevron, Folder, OpenExternal, Refresh } from './Icons'
import { OutputTree } from './OutputTree'

function IconBtn({
  title,
  onClick,
  children
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24,
        height: 24,
        border: 0,
        background: hover ? 'var(--field-2)' : 'transparent',
        color: hover ? 'var(--text)' : 'var(--text-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}

export function OutputPanel(): React.ReactElement {
  const folder = useStore((s) => s.config.sharedOutputFolder)
  const tree = useStore((s) => s.outputTree)
  const collapsed = useStore((s) => s.outputCollapsed)
  const height = useStore((s) => s.outputHeight)
  const setSharedOutput = useStore((s) => s.setSharedOutput)
  const refreshOutputTree = useStore((s) => s.refreshOutputTree)
  const toggleOutputPanel = useStore((s) => s.toggleOutputPanel)
  const setOutputHeight = useStore((s) => s.setOutputHeight)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const openOutputFolder = useStore((s) => s.openOutputFolder)

  // Same drag pattern as the sidebar-width handle; dragging up = taller.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = height
    const move = (ev: MouseEvent): void => setOutputHeight(startH + (startY - ev.clientY))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const browse = async (): Promise<void> => {
    const dir = await window.vivarium.browseFolder()
    if (dir) await setSharedOutput(dir)
  }

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Open in Explorer', onSelect: () => openOutputFolder() },
      { label: 'Change folder…', onSelect: () => void browse() },
      { label: 'Refresh', onSelect: () => void refreshOutputTree() },
      { label: '---' },
      { label: 'Clear folder', danger: true, onSelect: () => void setSharedOutput(null) }
    ])
  }

  const border = { flex: 'none' as const, borderTop: '1px solid var(--border-2)', background: 'var(--sidebar)' }

  // --- no folder configured yet ---
  if (!folder) {
    return (
      <>
      <div style={{ ...border, padding: '10px 12px 12px 12px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 11,
            letterSpacing: '.5px',
            textTransform: 'uppercase',
            color: 'var(--text-3)',
            marginBottom: 8,
            paddingLeft: 2
          }}
        >
          <Folder size={13} />
          Shared output
        </div>
        <button
          onClick={() => void browse()}
          style={{
            width: '100%',
            height: 34,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            background: 'var(--field-2)',
            border: '1px dashed var(--border)',
            color: 'var(--text-2)',
            fontSize: 12.5,
            cursor: 'pointer'
          }}
        >
          <Folder size={14} />
          Set output folder…
        </button>
      </div>
      <DiffBaseRow />
      </>
    )
  }

  // --- folder configured ---
  // Expanded: fixed user-dragged height (body scrolls beyond it); the
  // percentage maxHeight keeps the project list alive if the window shrinks
  // below the stored height. Collapsed: shrink-wraps to the header row.
  return (
    <>
    <div
      style={{
        ...border,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: collapsed ? undefined : height,
        maxHeight: collapsed ? undefined : '70%'
      }}
    >
      {!collapsed && (
        <div
          onMouseDown={startResize}
          style={{ position: 'absolute', top: -3, left: 0, right: 0, height: 6, cursor: 'row-resize', zIndex: 5 }}
        />
      )}
      {/* header */}
      <div
        onClick={toggleOutputPanel}
        onContextMenu={showMenu}
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 34,
          padding: '0 8px 0 10px',
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <span
          style={{
            width: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-3)',
            transform: `rotate(${collapsed ? 0 : 90}deg)`,
            transition: 'transform .12s'
          }}
        >
          <Chevron size={13} />
        </span>
        <span style={{ color: 'var(--accent-2)', display: 'flex' }}>
          <Folder size={14} />
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 'none' }}>Shared output</span>
        <span
          title={folder}
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            color: 'var(--text-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {leaf(folder)}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1 }} onClick={(e) => e.stopPropagation()}>
          <IconBtn title="Open in Explorer" onClick={() => openOutputFolder()}>
            <OpenExternal size={13} />
          </IconBtn>
          <IconBtn title="Refresh" onClick={() => void refreshOutputTree()}>
            <Refresh size={13} />
          </IconBtn>
          <IconBtn title="Change folder…" onClick={() => void browse()}>
            <Folder size={13} />
          </IconBtn>
        </div>
      </div>

      {/* tree body */}
      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '2px 0 8px 0', minHeight: 0 }}>
          {tree.length === 0 ? (
            <div
              style={{
                padding: '14px 12px',
                textAlign: 'center',
                color: 'var(--text-3)',
                fontSize: 12,
                fontStyle: 'italic'
              }}
            >
              No files yet — artifacts written to this folder appear here.
            </div>
          ) : (
            <OutputTree nodes={tree} />
          )}
        </div>
      )}
    </div>
    <DiffBaseRow />
    </>
  )
}

// Configurable base ref for the "Write branch diff" project action. Lives at the
// very bottom-left; persisted on blur / Enter.
function DiffBaseRow(): React.ReactElement {
  const diffBase = useStore((s) => s.config.diffBase)
  const setDiffBase = useStore((s) => s.setDiffBase)
  const [draft, setDraft] = React.useState(diffBase ?? 'origin/master')

  // keep the field in sync if the config changes elsewhere
  React.useEffect(() => {
    setDraft(diffBase ?? 'origin/master')
  }, [diffBase])

  const commit = (): void => {
    const v = draft.trim() || 'origin/master'
    if (v !== (diffBase ?? 'origin/master')) void setDiffBase(v)
  }

  return (
    <div
      style={{
        flex: 'none',
        borderTop: '1px solid var(--border-2)',
        background: 'var(--sidebar)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        height: 34
      }}
    >
      <span
        title="The 'Write branch diff' action diffs the current branch against this ref."
        style={{ fontSize: 11, color: 'var(--text-3)', flex: 'none', whiteSpace: 'nowrap' }}
      >
        Diff base
      </span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        spellCheck={false}
        placeholder="origin/master"
        style={{
          flex: 1,
          minWidth: 0,
          height: 24,
          background: 'var(--field-2)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          padding: '0 8px',
          outline: 'none'
        }}
      />
    </div>
  )
}
