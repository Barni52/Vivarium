import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'

// Shown when the user tries to close the app (title-bar ✕, Alt+F4, taskbar
// close — all intercepted in main). Quitting kills local terminals but leaves
// every project container running, so spell that out rather than implying a
// full teardown.
export function ConfirmQuit(): React.ReactElement {
  const closeDialog = useStore((s) => s.closeDialog)
  const confirmQuit = useStore((s) => s.confirmQuit)

  return (
    <Overlay onClose={closeDialog} center>
      <Panel width={400}>
        <div style={{ padding: '22px 24px 18px 24px' }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Quit Vivarium?</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Local terminals close and running agents lose their live session. Project containers
            keep running in the background — reopen the app to reconnect.
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--border-2)' }}>
          <FooterButton height={48} onClick={closeDialog}>
            Cancel
          </FooterButton>
          <FooterButton height={48} danger onClick={confirmQuit}>
            Quit
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
