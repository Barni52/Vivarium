import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton, ImageToggle, fieldStyle, labelStyle } from '../ui'
import { MountList } from '../MountList'
import { Restart, Trash } from '../Icons'
import { toAbs } from '../../paths'

export function ProjectSettings(): React.ReactElement | null {
  const st = useStore((s) => s.st)
  const setSt = useStore((s) => s.setSt)
  const closeDialog = useStore((s) => s.closeDialog)
  const saveSettings = useStore((s) => s.saveSettings)
  const restart = useStore((s) => s.restart)
  const requestDeleteProject = useStore((s) => s.requestDeleteProject)
  const [restartHover, setRestartHover] = React.useState(false)
  const [deleteHover, setDeleteHover] = React.useState(false)

  if (!st) return null
  const slim = st.image === 'slim'

  const addMount = (name: string): void => {
    const abs = toAbs(st.basePath, name)
    setSt(st.mounts.includes(abs) ? { mountDraft: '' } : { mounts: [...st.mounts, abs], mountDraft: '' })
  }

  const browseMount = async (): Promise<void> => {
    const dir = await window.vivarium.browseFolder()
    if (dir) addMount(dir)
  }

  return (
    <Overlay onClose={closeDialog}>
      <Panel>
        <div style={{ padding: '20px 24px 4px 24px', flex: 'none' }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: '.6px',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 6
            }}
          >
            Project settings
          </div>
          <div style={{ fontSize: 19, fontWeight: 600 }}>{st.name}</div>
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
            <input value={st.name} onChange={(e) => setSt({ name: e.target.value })} style={fieldStyle()} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>Base folder</label>
            <input value={st.basePath} onChange={(e) => setSt({ basePath: e.target.value })} style={fieldStyle(true)} />
          </div>

          <MountList
            mounts={st.mounts}
            basePath={st.basePath}
            draft={st.mountDraft}
            setDraft={(v) => setSt({ mountDraft: v })}
            locked={st.locked}
            lockedNote="Mounts can’t change while a session is live — stop the container to edit them."
            onAdd={addMount}
            onBrowse={browseMount}
            onRemove={(i) => setSt({ mounts: st.mounts.filter((_, j) => j !== i) })}
          />

          <div style={{ display: 'flex', gap: 20 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <label style={labelStyle}>Image variant</label>
              <ImageToggle value={st.image} onChange={(image) => setSt({ image })} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <label style={labelStyle}>
                Published port{' '}
                <span style={{ color: 'var(--text-3)' }}>{slim ? '(Full image only)' : ''}</span>
              </label>
              <input
                value={st.port}
                disabled={slim}
                onChange={(e) => setSt({ port: e.target.value })}
                placeholder={slim ? '—' : '4200'}
                style={{ ...fieldStyle(true), opacity: slim ? 0.5 : 1, cursor: slim ? 'not-allowed' : 'text' }}
              />
            </div>
          </div>

          <button
            onClick={() => restart(st.id)}
            onMouseEnter={() => setRestartHover(true)}
            onMouseLeave={() => setRestartHover(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 40,
              border: '1px solid var(--border)',
              background: restartHover ? 'var(--field)' : 'transparent',
              borderColor: restartHover ? 'var(--text-3)' : 'var(--border)',
              color: 'var(--text)',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            <Restart />
            Restart container
          </button>

          <button
            onClick={() => requestDeleteProject(st.id, st.name)}
            onMouseEnter={() => setDeleteHover(true)}
            onMouseLeave={() => setDeleteHover(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 40,
              border: '1px solid',
              borderColor: deleteHover ? 'var(--danger)' : 'var(--border)',
              background: deleteHover ? 'rgba(250,77,86,.12)' : 'transparent',
              color: 'var(--danger)',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            <Trash />
            Delete project
          </button>
        </div>

        <div style={{ flex: 'none', display: 'flex', borderTop: '1px solid var(--border-2)' }}>
          <FooterButton onClick={closeDialog}>Cancel</FooterButton>
          <FooterButton primary onClick={saveSettings}>
            Save changes
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
