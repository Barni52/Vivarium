import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'
import { MONO } from '../../theme'

export function ConfirmDeleteProject(): React.ReactElement | null {
  const target = useStore((s) => s.deleteTarget)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirmDeleteProject = useStore((s) => s.confirmDeleteProject)

  if (!target) return null

  return (
    <Overlay onClose={closeDialog} center>
      <Panel width={400}>
        <div style={{ padding: '22px 24px 18px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Delete project?</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
            This removes{' '}
            <span style={{ color: 'var(--fg)', fontFamily: MONO }}>
              {target.name}
            </span>{' '}
            and all its sessions, and force-removes its container. Any chat session’s{' '}
            <b style={{ color: 'var(--fg)' }}>conversation is deleted with it</b>. Your folders on
            the host are not touched.
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--border)' }}>
          <FooterButton height={48} danger onClick={confirmDeleteProject}>
            Delete project
          </FooterButton>
          <FooterButton height={48} onClick={closeDialog}>
            Cancel
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
