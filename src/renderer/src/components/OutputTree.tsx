import React from 'react'
import type { OutputNode } from '@shared/types'
import { useStore } from '../state/store'
import { Chevron, Folder, File } from './Icons'

const isHtml = (name: string): boolean => /\.html?$/i.test(name)

function OutputRow({ node, depth }: { node: OutputNode; depth: number }): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const expanded = useStore((s) => !!s.outputExpanded[node.path])
  const toggleDir = useStore((s) => s.toggleOutputDir)
  const openFile = useStore((s) => s.openOutputFile)
  const deleteOutputPath = useStore((s) => s.deleteOutputPath)
  const openContextMenu = useStore((s) => s.openContextMenu)

  const isDir = node.type === 'dir'
  const html = !isDir && isHtml(node.name)
  const pad = 10 + depth * 14

  const showMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      {
        label: isDir ? 'Delete folder' : 'Delete file',
        danger: true,
        onSelect: () => void deleteOutputPath(node.path)
      }
    ])
  }

  return (
    <>
      <div
        onClick={() => (isDir ? toggleDir(node.path) : openFile(node.path))}
        onContextMenu={showMenu}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={isDir ? node.path : html ? `Open ${node.name} in browser` : `Open ${node.name}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          paddingLeft: pad,
          paddingRight: 8,
          cursor: 'pointer',
          background: hover ? 'var(--row-hover)' : 'transparent'
        }}
      >
        <span
          style={{
            width: 12,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-3)',
            transform: `rotate(${expanded ? 90 : 0}deg)`,
            transition: 'transform .12s',
            visibility: isDir ? 'visible' : 'hidden'
          }}
        >
          <Chevron size={12} />
        </span>
        <span
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            color: isDir ? 'var(--text-2)' : html ? 'var(--accent-2)' : 'var(--text-3)'
          }}
        >
          {isDir ? <Folder size={13} /> : <File size={13} />}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            color: isDir ? 'var(--text)' : html ? 'var(--accent-2)' : 'var(--text-2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {node.name}
        </span>
      </div>

      {isDir &&
        expanded &&
        (node.children ?? []).map((child) => (
          <OutputRow key={child.path} node={child} depth={depth + 1} />
        ))}
    </>
  )
}

export function OutputTree({ nodes }: { nodes: OutputNode[] }): React.ReactElement {
  return (
    <>
      {nodes.map((n) => (
        <OutputRow key={n.path} node={n} depth={0} />
      ))}
    </>
  )
}
