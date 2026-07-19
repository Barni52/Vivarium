import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'

export function ConfirmDeleteProject(): React.ReactElement | null {
  const target = useStore((s) => s.deleteTarget)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirmDeleteProject = useStore((s) => s.confirmDeleteProject)

  if (!target) return null

  return (
    <Overlay onClose={closeDialog} center>
      <Panel width={400}>
        <div style={{ padding: '22px 24px 18px 24px' }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Delete project?</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            This removes{' '}
            <span style={{ color: 'var(--text)', fontFamily: "'IBM Plex Mono', monospace" }}>
              {target.name}
            </span>{' '}
            and all its sessions, and force-removes its container. Your folders on the host are
            not touched.
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--border-2)' }}>
          <FooterButton height={48} onClick={closeDialog}>
            Cancel
          </FooterButton>
          <FooterButton height={48} danger onClick={confirmDeleteProject}>
            Delete project
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
