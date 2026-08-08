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

/**
 * Path equality, Windows-style: case-insensitive, and blind to a trailing
 * slash. The picker hands back `C:\Projects\Api` for something the user may
 * have typed as `api`, and an exact `includes()` would happily mount both.
 */
export function samePath(a: string, b: string): boolean {
  return stripTrailing(a).toLowerCase() === stripTrailing(b).toLowerCase()
}

/**
 * Split what was typed into one entry per folder, so `frontend, backend, libs`
 * is one keystroke's worth of work rather than three trips through the field.
 *
 * Commas and semicolons are legal in a Windows folder name, so this does cost
 * the ability to *type* `My, Docs` — the trade is deliberate: separators are
 * what people reach for constantly and a comma in a folder name is rare, and
 * Browse… (which never goes through here) still adds those paths intact.
 */
export function splitEntries(v: string): string[] {
  return v
    .split(/[,;\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Fold typed or picked entries into an existing mount list: each resolved
 * against the base folder, blanks dropped, and deduped against what is already
 * there *and* against the rest of the batch — a multi-select can repeat itself
 * once the same folder is reachable by two names.
 */
export function mergeMounts(basePath: string, existing: string[], added: string[]): string[] {
  const out = [...existing]
  for (const entry of added) {
    const abs = toAbs(basePath, entry)
    if (abs && !out.some((m) => samePath(m, abs))) out.push(abs)
  }
  return out
}

/** Final path segment (the container mount leaf name). */
export function leaf(p: string): string {
  const parts = stripTrailing(p).split(/[\\/]/)
  return parts[parts.length - 1] || p
}
