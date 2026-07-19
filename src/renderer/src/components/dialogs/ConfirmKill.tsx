import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'

export function ConfirmKill(): React.ReactElement | null {
  const target = useStore((s) => s.killTarget)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirmKill = useStore((s) => s.confirmKill)

  if (!target) return null

  return (
    <Overlay onClose={closeDialog} center>
      <Panel width={380}>
        <div style={{ padding: '22px 24px 18px 24px' }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Kill session?</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            This stops{' '}
            <span style={{ color: 'var(--text)', fontFamily: "'IBM Plex Mono', monospace" }}>
              {target.name}
            </span>{' '}
            and closes its terminal. The container keeps running.
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--border-2)' }}>
          <FooterButton height={48} onClick={closeDialog}>
            Cancel
          </FooterButton>
          <FooterButton height={48} danger onClick={confirmKill}>
            Kill session
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
