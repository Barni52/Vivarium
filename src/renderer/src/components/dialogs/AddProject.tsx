import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton, ImageToggle, fieldStyle, labelStyle } from '../ui'
import { MountList } from '../MountList'
import { toAbs } from '../../paths'

export function AddProject(): React.ReactElement {
  const ap = useStore((s) => s.ap)
  const setAp = useStore((s) => s.setAp)
  const closeDialog = useStore((s) => s.closeDialog)
  const createProject = useStore((s) => s.createProject)

  const browse = async (): Promise<void> => {
    const dir = await window.vivarium.browseFolder()
    if (dir) setAp({ basePath: dir })
  }

  const addMount = (name: string): void => {
    const abs = toAbs(ap.basePath, name)
    setAp(ap.mounts.includes(abs) ? { mountDraft: '' } : { mounts: [...ap.mounts, abs], mountDraft: '' })
  }

  const browseMount = async (): Promise<void> => {
    const dir = await window.vivarium.browseFolder()
    if (dir) addMount(dir)
  }

  const slim = ap.image === 'slim'

  return (
    <Overlay onClose={closeDialog}>
      <Panel>
        <div style={{ padding: '20px 24px 4px 24px', flex: 'none' }}>
          <div
            style={{
              fontSize: 11.5,
              letterSpacing: '.6px',
              textTransform: 'uppercase',
              color: 'var(--dim)',
              marginBottom: 6
            }}
          >
            New project
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Add project</div>
        </div>

        <div
          style={{
            padding: '16px 24px',
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 18
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Project name</label>
            <input
              value={ap.name}
              onChange={(e) => setAp({ name: e.target.value })}
              placeholder="my-service"
              style={fieldStyle()}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Base folder</label>
            <div style={{ display: 'flex' }}>
              <input
                value={ap.basePath}
                onChange={(e) => setAp({ basePath: e.target.value })}
                placeholder="C:\projects\my-service"
                style={{ ...fieldStyle(true), flex: 1 }}
              />
              <button
                onClick={browse}
                style={{
                  height: 40,
                  padding: '0 16px',
                  background: 'var(--card2)',
                  border: 0,
                  borderBottom: '1px solid var(--dim)',
                  color: 'var(--fg)',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                Browse…
              </button>
            </div>
          </div>

          <MountList
            mounts={ap.mounts}
            basePath={ap.basePath}
            draft={ap.mountDraft}
            setDraft={(v) => setAp({ mountDraft: v })}
            onAdd={addMount}
            onBrowse={browseMount}
            onRemove={(i) => setAp({ mounts: ap.mounts.filter((_, j) => j !== i) })}
          />

          <div style={{ display: 'flex', gap: 20 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <label style={labelStyle}>Image variant</label>
              <ImageToggle value={ap.image} onChange={(image) => setAp({ image })} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <label style={labelStyle}>
                Published port{' '}
                <span style={{ color: 'var(--dim)' }}>{slim ? '(Full image only)' : '(optional)'}</span>
              </label>
              <input
                value={ap.port}
                disabled={slim}
                onChange={(e) => setAp({ port: e.target.value })}
                placeholder={slim ? '—' : '4200'}
                style={{ ...fieldStyle(true), opacity: slim ? 0.5 : 1, cursor: slim ? 'not-allowed' : 'text' }}
              />
            </div>
          </div>
        </div>

        <div style={{ flex: 'none', display: 'flex', borderTop: '1px solid var(--border)' }}>
          <FooterButton primary onClick={createProject}>
            Create project
          </FooterButton>
          <FooterButton onClick={closeDialog}>Cancel</FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
