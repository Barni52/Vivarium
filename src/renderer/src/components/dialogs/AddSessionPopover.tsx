import React from 'react'
import type { SessionType } from '@shared/types'
import { useStore } from '../../state/store'
import { Sparkle, Terminal } from '../Icons'

const CARDS: {
  type: SessionType
  title: string
  subtitle: string
  color: string
  bg: string
  selBg: string
  icon: React.ReactNode
}[] = [
  {
    type: 'agent',
    title: 'Agent',
    subtitle: 'Claude Code in the container',
    color: '#a56eff',
    bg: 'rgba(165,110,255,.14)',
    selBg: 'rgba(165,110,255,.08)',
    icon: <Sparkle size={17} />
  },
  {
    type: 'container-shell',
    title: 'Terminal · container',
    subtitle: 'bash inside the container',
    color: '#3ddbd9',
    bg: 'rgba(61,219,217,.13)',
    selBg: 'rgba(61,219,217,.07)',
    icon: <Terminal size={17} />
  },
  {
    type: 'host-shell',
    title: 'Terminal · host',
    subtitle: 'PowerShell in the project folder',
    color: '#42be65',
    bg: 'rgba(66,190,101,.13)',
    selBg: 'rgba(66,190,101,.07)',
    icon: <Terminal size={17} />
  }
]

const defaultName = (type: SessionType, existing: number): string => {
  const base = type === 'agent' ? 'agent' : type === 'container-shell' ? 'bash' : 'ps-host'
  return `${base}-${existing + 1}`
}

export function AddSessionPopover(): React.ReactElement | null {
  const draft = useStore((s) => s.addSession)
  const setAddSession = useStore((s) => s.setAddSession)
  const closeDialog = useStore((s) => s.closeDialog)
  const confirm = useStore((s) => s.confirmAddSession)
  const project = useStore((s) => s.config.projects.find((p) => p.id === draft?.projectId))

  if (!draft) return null

  const pick = (type: SessionType): void => {
    const count = project?.sessions.filter((s) => s.type === type).length ?? 0
    setAddSession({ type, name: defaultName(type, count) })
  }

  return (
    <div onClick={closeDialog} style={{ position: 'absolute', inset: 0, zIndex: 45 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: draft.top,
          left: draft.left,
          width: 300,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          boxShadow: '0 18px 44px -16px rgba(0,0,0,.7)',
          animation: 'vpop .13s ease',
          padding: 14
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
          New session in{' '}
          <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>{project?.name}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {CARDS.map((c) => {
            const selected = draft.type === c.type
            return (
              <button
                key={c.type}
                onClick={() => pick(c.type)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: '11px 12px',
                  border: `1.5px solid ${selected ? c.color : 'var(--border)'}`,
                  background: selected ? c.selBg : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    flex: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: c.bg,
                    color: c.color
                  }}
                >
                  {c.icon}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{c.title}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{c.subtitle}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 13 }}>
          <label style={{ fontSize: 12, color: 'var(--text-2)' }}>Session name</label>
          <input
            value={draft.name}
            autoFocus
            onChange={(e) => setAddSession({ name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
            }}
            style={{
              height: 36,
              background: 'var(--field)',
              border: 0,
              borderBottom: '1px solid var(--text-3)',
              color: 'var(--text)',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 13,
              padding: '0 10px',
              outline: 'none'
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            onClick={confirm}
            style={{
              flex: 1,
              height: 38,
              border: 0,
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            Create
          </button>
          <button
            onClick={closeDialog}
            style={{
              flex: 1,
              height: 38,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-2)',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
