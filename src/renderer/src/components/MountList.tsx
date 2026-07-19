import React from 'react'
import { Folder, Plus, Close, Lock } from './Icons'
import { leaf, relLabel } from '../paths'

export function MountList({
  mounts,
  basePath,
  draft,
  setDraft,
  onAdd,
  onBrowse,
  onRemove,
  locked,
  lockedNote
}: {
  /** absolute host paths */
  mounts: string[]
  /** base folder, used only to display mounts relative to it */
  basePath: string
  draft?: string
  setDraft?: (v: string) => void
  onAdd?: (name: string) => void
  onBrowse?: () => void
  onRemove?: (index: number) => void
  locked?: boolean
  lockedNote?: string
}): React.ReactElement {
  const editable = !locked && !!onAdd
  const add = (): void => {
    const v = (draft ?? '').trim().replace(/^\/+/, '')
    if (v && onAdd) onAdd(v)
  }
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--field)', opacity: locked ? 0.62 : 1 }}>
      <div style={{ padding: '13px 16px 12px 16px', borderBottom: '1px solid var(--border-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--accent)', display: 'flex' }}>
            <Folder />
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Mount folders</span>
          {locked ? (
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-3)',
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 5
              }}
            >
              <Lock /> Locked
            </span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
              {mounts.length} {mounts.length === 1 ? 'folder' : 'folders'}
            </span>
          )}
        </div>
        {locked ? (
          <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6, lineHeight: 1.5 }}>
            {lockedNote ?? 'Mounts can’t change while the container is running — stop it to edit them.'}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 5, lineHeight: 1.5 }}>
            Only these subfolders are mounted into the container. Everything else in the base
            folder stays on the host.
          </div>
        )}
      </div>

      {editable && (
        <div style={{ display: 'flex', padding: '12px 16px 10px 16px' }}>
          <input
            value={draft ?? ''}
            onChange={(e) => setDraft?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="e.g. frontend"
            style={{
              flex: 1,
              height: 36,
              background: 'var(--field-2)',
              border: 0,
              borderBottom: '1px solid var(--text-3)',
              color: 'var(--text)',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 13,
              padding: '0 12px',
              outline: 'none'
            }}
          />
          {onBrowse && (
            <button
              onClick={onBrowse}
              title="Choose a folder…"
              style={{
                height: 36,
                padding: '0 14px',
                background: 'var(--field-2)',
                border: 0,
                borderBottom: '1px solid var(--text-3)',
                color: 'var(--text)',
                fontSize: 13,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                whiteSpace: 'nowrap'
              }}
            >
              <Folder size={13} />
              Browse…
            </button>
          )}
          <button
            onClick={add}
            style={{
              height: 36,
              padding: '0 16px',
              background: 'var(--accent)',
              border: 0,
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      )}

      <div
        style={{
          padding: editable ? '0 16px 14px 16px' : '12px 16px 14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minHeight: 96
        }}
      >
        {mounts.length === 0 ? (
          <div
            style={{
              flex: 1,
              minHeight: 88,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              border: '1px dashed var(--border)',
              color: 'var(--text-3)'
            }}
          >
            <span style={{ fontSize: 13 }}>No folders mounted yet</span>
            <span style={{ fontSize: 11.5 }}>Add the subfolders your agent should see.</span>
          </div>
        ) : (
          mounts.map((m, i) => (
            <div
              key={`${m}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 38,
                padding: '0 6px 0 12px',
                background: 'var(--field-2)',
                borderLeft: '2px solid var(--accent)'
              }}
            >
              <span style={{ color: 'var(--text-3)', display: 'flex' }}>
                <Folder size={13} />
              </span>
              <span style={{ flex: 1, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--text)' }}>
                {relLabel(basePath, m)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: "'IBM Plex Mono', monospace" }}>
                → /workspace/{leaf(m)}
              </span>
              {editable && onRemove && (
                <button
                  onClick={() => onRemove(i)}
                  style={{
                    width: 28,
                    height: 28,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--text-3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <Close size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
