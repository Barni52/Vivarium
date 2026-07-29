import React from 'react'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'
import { MONO } from '../../theme'

// Shown for every cross-project drop in the sidebar. It confirms unconditionally
// rather than only for a live session, because this dialog is the only place the
// user is told what a move actually does — and the two halves pull in opposite
// directions. The conversation follows the session (claudeSessionId travels with
// it and /home/node/.claude is the same volume in every container, so the agent
// resumes the same transcript), but the *files* do not: /workspace is the target
// project's mounts now, so paths from earlier in the conversation may not exist
// there. That is the point of the feature, and also the thing worth a sentence.
export function ConfirmMove(): React.ReactElement | null {
  const target = useStore((s) => s.moveTarget)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirmMoveSession = useStore((s) => s.confirmMoveSession)

  if (!target) return null

  const mono: React.CSSProperties = {
    color: 'var(--text)',
    fontFamily: MONO
  }

  return (
    <Overlay onClose={closeDialog} center>
      <Panel width={400}>
        <div style={{ padding: '22px 24px 18px 24px' }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Move session?</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            <span style={mono}>{target.sessionName}</span> moves to{' '}
            <span style={mono}>{target.toProjectName}</span> and reopens in that project’s
            container, against that project’s mounts — so file paths from earlier in the
            conversation may not exist there.
            {target.live && (
              <>
                {' '}
                Its terminal is live: the current turn is cut off
                {/* the scrollback goes with the old container's terminal, but an
                    agent's history doesn't — claude resumes and re-renders it */}
                {' '}
                and its scrollback is discarded. The conversation itself is kept and resumes in the
                new container.
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid var(--border-2)' }}>
          {/* danger only when something is actually being cut off; a dead session
              moving is an ordinary confirm */}
          <FooterButton
            height={48}
            danger={target.live}
            primary={!target.live}
            onClick={confirmMoveSession}
          >
            Move session
          </FooterButton>
          <FooterButton height={48} onClick={closeDialog}>
            Cancel
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
