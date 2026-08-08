import React from 'react'
import type { VolumeInfo } from '@shared/types'
import { useStore } from '../../state/store'
import { Overlay, Panel, FooterButton } from '../ui'
import { Disks, Lock, Refresh, Trash } from '../Icons'
import { MONO } from '../../theme'

// Docker volume housekeeping.
//
// Vivarium creates volumes in three places and, until this dialog, removed them
// in none: mounting a folder with a package.json or pom.xml silently overlays
// container-local caches on its build output (node_modules, .angular, Maven
// target), and deleting a project removes its container but never those caches.
// They are per *host path*, keyed by a hash of it, so renaming or unmounting a
// folder strands gigabytes under a name nobody can read back.
//
// So the job of this screen is one sentence: show what is on disk, say which of
// it is still wanted, and let the rest go. Orphans lead because they are the
// answer to "why is my disk full"; the shared Claude volumes are shown but never
// removable — the sign-in and every agent's memory live there.

function sizeLabel(v: VolumeInfo): string {
  return v.size ?? '—'
}

/** Sum of known byte counts, rendered the way docker would. */
function totalLabel(volumes: VolumeInfo[]): string | null {
  const known = volumes.filter((v) => v.bytes !== null)
  if (known.length === 0) return null
  const bytes = known.reduce((n, v) => n + (v.bytes ?? 0), 0)
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i += 1
  }
  return `${n < 10 && i > 0 ? n.toFixed(2) : Math.round(n)}${units[i]}`
}

/** Orphan = ours, unused by any container, and no current mount claims it. */
function isOrphan(v: VolumeInfo): boolean {
  return !v.locked && v.links === 0 && v.projects.length === 0
}

function Row({ volume }: { volume: VolumeInfo }): React.ReactElement {
  const busy = useStore((s) => !!s.volumeBusy[volume.name])
  const error = useStore((s) => s.volumeErrors[volume.name])
  const removeVolume = useStore((s) => s.removeVolume)
  const [hover, setHover] = React.useState(false)

  const orphan = isOrphan(volume)
  const inUse = volume.links > 0
  // What this volume is *for*, in one line: the mount it caches, the project
  // that owns it, or the fact that nothing does.
  const detail = volume.locked
    ? 'Claude sign-in, settings and agent memory — shared with claude-box'
    : volume.contents
      ? orphan
        ? `${volume.contents} — no mounted folder uses this any more`
        : volume.projects.length > 0
          ? `${volume.contents} · ${volume.projects.join(', ')}`
          : // A container is holding it, yet no current mount hashes to it: the
            // project was deleted (or its folder unmounted) while the container
            // kept running. Not an orphan while something still uses it, but
            // nothing will claim it once that container goes.
            `${volume.contents} — in use, but no current mount claims it`
      : orphan
        ? 'unrecognised — nothing in this app accounts for it'
        : 'unrecognised'

  const reason = volume.locked
    ? 'The Claude sign-in lives here — removing it would sign every agent out'
    : inUse
      ? `In use by ${volume.links} container${volume.links === 1 ? '' : 's'} — stop it first`
      : ''

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 46,
        padding: '0 24px',
        borderTop: '1px solid var(--border)',
        background: hover ? 'var(--sel)' : 'transparent'
      }}
    >
      {/* An orphan is the only state worth colouring — everything else here is
          working as intended. */}
      <span
        title={orphan ? 'Orphaned' : inUse ? 'In use' : 'Idle'}
        style={{
          width: 8,
          height: 8,
          flex: 'none',
          borderRadius: 2,
          background: orphan ? 'var(--danger)' : inUse ? 'var(--ok)' : 'transparent',
          border: `1.5px solid ${orphan ? 'var(--danger)' : inUse ? 'var(--ok)' : 'var(--dim)'}`
        }}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          title={volume.name}
          style={{
            fontFamily: MONO,
            fontSize: 12.5,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {volume.name}
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: error ? 'var(--danger)' : 'var(--dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {error ?? detail}
        </span>
      </div>

      <span
        style={{
          fontFamily: MONO,
          fontSize: 12.5,
          color: volume.bytes ? 'var(--muted)' : 'var(--dim)',
          flex: 'none'
        }}
      >
        {sizeLabel(volume)}
      </span>

      <span style={{ width: 28, display: 'flex', justifyContent: 'flex-end', flex: 'none' }}>
        {busy ? (
          <span style={{ fontSize: 11.5, color: 'var(--dim)', animation: 'vpending 1.2s ease-in-out infinite' }}>
            …
          </span>
        ) : volume.locked ? (
          <span title={reason} style={{ color: 'var(--dim)', display: 'flex' }}>
            <Lock />
          </span>
        ) : (
          <button
            title={reason || `Remove ${volume.name}`}
            disabled={inUse}
            onClick={() => void removeVolume(volume.name)}
            style={{
              width: 26,
              height: 26,
              border: 0,
              background: 'transparent',
              color: inUse ? 'var(--dim)' : hover ? 'var(--danger)' : 'var(--muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: inUse ? 'default' : 'pointer',
              opacity: inUse ? 0.45 : 1
            }}
          >
            <Trash size={14} />
          </button>
        )}
      </span>
    </div>
  )
}

function Group({ title, volumes }: { title: string; volumes: VolumeInfo[] }): React.ReactElement | null {
  if (volumes.length === 0) return null
  const total = totalLabel(volumes)
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '13px 24px 5px 24px',
          borderTop: '1px solid var(--border)',
          background: 'var(--input)',
          fontSize: 11.5,
          letterSpacing: '.7px',
          textTransform: 'uppercase',
          color: 'var(--dim)'
        }}
      >
        {title}
        <span style={{ flex: 1 }} />
        {total && <span style={{ fontFamily: MONO }}>{total}</span>}
      </div>
      {volumes.map((v) => (
        <Row key={v.name} volume={v} />
      ))}
    </>
  )
}

export function Volumes(): React.ReactElement {
  const volumes = useStore((s) => s.volumes)
  const loading = useStore((s) => s.volumesLoading)
  const sized = useStore((s) => s.volumesSized)
  const error = useStore((s) => s.volumesError)
  const busy = useStore((s) => Object.keys(s.volumeBusy).length > 0)
  const closeDialog = useStore((s) => s.closeDialog)
  const refreshVolumes = useStore((s) => s.refreshVolumes)
  const removeOrphanVolumes = useStore((s) => s.removeOrphanVolumes)
  const [refreshHover, setRefreshHover] = React.useState(false)

  const all = volumes ?? []
  // Biggest first inside each group: the reason anyone opens this dialog is
  // disk space, and the row that matters is the fat one.
  const bySize = [...all].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
  const orphans = bySize.filter(isOrphan)
  const active = bySize.filter((v) => !v.locked && !isOrphan(v))
  const shared = bySize.filter((v) => v.locked)
  const orphanTotal = totalLabel(orphans)

  return (
    <Overlay onClose={busy ? (): void => {} : closeDialog}>
      <Panel width={560}>
        <div style={{ padding: '20px 24px 18px 24px', flex: 'none' }}>
          <div
            style={{
              fontSize: 11.5,
              letterSpacing: '.6px',
              textTransform: 'uppercase',
              color: 'var(--dim)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 7
            }}
          >
            <Disks size={13} />
            Docker volumes
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {loading && volumes === null
                ? 'Measuring…'
                : totalLabel(all)
                  ? `${totalLabel(all)} on disk`
                  : `${all.length} volume${all.length === 1 ? '' : 's'}`}
            </div>
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--dim)',
                flex: 1,
                animation: loading ? 'vpending 1.2s ease-in-out infinite' : 'none'
              }}
            >
              {loading
                ? 'reading every volume — this takes a moment'
                : orphans.length > 0
                  ? `${orphans.length} orphaned${orphanTotal ? ` · ${orphanTotal}` : ''}`
                  : 'nothing orphaned'}
            </span>
            <button
              title="Measure again"
              onClick={() => void refreshVolumes()}
              onMouseEnter={() => setRefreshHover(true)}
              onMouseLeave={() => setRefreshHover(false)}
              style={{
                width: 28,
                height: 28,
                border: 0,
                background: refreshHover ? 'var(--card2)' : 'transparent',
                color: refreshHover ? 'var(--fg)' : 'var(--muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flex: 'none'
              }}
            >
              <Refresh />
            </button>
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, marginTop: 10 }}>
            Mounting a folder with a <code>package.json</code> or <code>pom.xml</code> gives it
            container-local caches so installs and builds never touch your Windows checkout.
            Nothing else in Vivarium removes them — not even deleting the project.
          </div>
        </div>

        <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: '0 1 auto' }}>
          <Group title="Orphaned — no mount claims these" volumes={orphans} />
          <Group title="In use by your projects" volumes={active} />
          <Group title="Shared Claude volumes" volumes={shared} />
          {!loading && all.length === 0 && (
            <div
              style={{
                padding: '14px 24px 18px 24px',
                borderTop: '1px solid var(--border)',
                fontSize: 12.5,
                fontStyle: 'italic',
                color: 'var(--dim)'
              }}
            >
              {error ? `Could not read volumes: ${error}` : 'No Vivarium volumes on this machine.'}
            </div>
          )}
        </div>

        {/* Sizes are the whole point of the screen, so say so when they're missing
            rather than showing a table of dashes and letting it look broken. */}
        {!sized && all.length > 0 && (
          <div
            style={{
              flex: 'none',
              padding: '12px 24px',
              borderTop: '1px solid var(--border)',
              background: 'var(--input)',
              fontSize: 11.5,
              color: 'var(--muted)',
              lineHeight: 1.5
            }}
          >
            Docker couldn’t report sizes{error ? ` (${error})` : ''} — the volumes are listed and
            can still be removed, but without measurements.
          </div>
        )}

        <div style={{ flex: 'none', display: 'flex', borderTop: '1px solid var(--border)' }}>
          <FooterButton
            primary={orphans.length > 0}
            height={48}
            disabled={busy || orphans.length === 0}
            onClick={() => void removeOrphanVolumes()}
          >
            {busy
              ? 'Removing…'
              : orphans.length === 0
                ? 'Nothing to reclaim'
                : `Remove ${orphans.length} orphaned${orphanTotal ? ` · ${orphanTotal}` : ''}`}
          </FooterButton>
          <FooterButton height={48} disabled={busy} onClick={closeDialog}>
            Close
          </FooterButton>
        </div>
      </Panel>
    </Overlay>
  )
}
