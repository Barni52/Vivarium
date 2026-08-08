import React from 'react'
import { Folder, Plus, Close, Lock } from './Icons'
import { leaf, relLabel } from '../paths'
import { MONO } from '../theme'

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
    <div style={{ border: '1px solid var(--border)', background: 'var(--input)', opacity: locked ? 0.62 : 1 }}>
      <div style={{ padding: '13px 16px 12px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--accent)', display: 'flex' }}>
            <Folder />
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Mount folders</span>
          {locked ? (
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--dim)',
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 5
              }}
            >
              <Lock /> Locked
            </span>
          ) : (
            <span style={{ fontSize: 11.5, color: 'var(--dim)', marginLeft: 'auto' }}>
              {mounts.length} {mounts.length === 1 ? 'folder' : 'folders'}
            </span>
          )}
        </div>
        {locked ? (
          <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6, lineHeight: 1.5 }}>
            {lockedNote ?? 'Mounts can’t change while the container is running — stop it to edit them.'}
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--dim)', marginTop: 5, lineHeight: 1.5 }}>
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
              background: 'var(--card2)',
              border: 0,
              borderBottom: '1px solid var(--dim)',
              color: 'var(--fg)',
              fontFamily: MONO,
              fontSize: 12.5,
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
                background: 'var(--card2)',
                border: 0,
                borderBottom: '1px solid var(--dim)',
                color: 'var(--fg)',
                fontSize: 12.5,
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
              color: 'var(--accent-fg)',
              fontSize: 12.5,
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
              color: 'var(--dim)'
            }}
          >
            <span style={{ fontSize: 12.5 }}>No folders mounted yet</span>
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
                background: 'var(--card2)',
                borderLeft: '2px solid var(--accent)'
              }}
            >
              <span style={{ color: 'var(--dim)', display: 'flex' }}>
                <Folder size={13} />
              </span>
              <span style={{ flex: 1, fontFamily: MONO, fontSize: 12.5, color: 'var(--fg)' }}>
                {relLabel(basePath, m)}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--dim)', fontFamily: MONO }}>
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
                    color: 'var(--dim)',
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
