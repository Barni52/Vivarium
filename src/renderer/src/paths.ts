// Path helpers for the renderer (no node path available). Mounts are entered and
// displayed as subfolder names relative to the project's base folder, but are
// persisted as absolute host paths (what docker bind mounts require).

function stripTrailing(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

/** True for a drive-letter path (C:\…), a UNC path (\\…), or a POSIX-absolute path. */
export function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/')
}

/**
 * Resolve a mount entry to an absolute Windows path. A value the user typed as
 * already-absolute (or containing a drive colon) is used as-is — never
 * concatenated onto the base folder, which would produce an invalid
 * `C:\base\C:\…` path that docker rejects with "invalid mode".
 */
export function toAbs(basePath: string, rel: string): string {
  const r = rel.trim()
  if (isAbsolute(r) || r.includes(':')) return stripTrailing(r)
  const base = stripTrailing(basePath)
  const clean = r.replace(/^[\\/]+/, '').replace(/\//g, '\\')
  if (!base) return clean
  if (!clean) return base
  return `${base}\\${clean}`
}

/** Display label for an absolute mount path, relative to base when possible. */
export function relLabel(basePath: string, abs: string): string {
  const base = stripTrailing(basePath)
  if (base && abs.toLowerCase().startsWith(base.toLowerCase())) {
    return abs.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  }
  return leaf(abs)
}

/** Final path segment (the container mount leaf name). */
export function leaf(p: string): string {
  const parts = stripTrailing(p).split(/[\\/]/)
  return parts[parts.length - 1] || p
}
