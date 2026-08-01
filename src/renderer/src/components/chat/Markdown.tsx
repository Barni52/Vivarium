import React from 'react'
import { MONO } from '../../theme'

// Enough markdown for a conversation: headings, bullets, ordered lists, fenced
// code, `inline code` and **bold**. Deliberately small — this is a personal tool
// reading Claude Code's own prose, and a full parser is a dependency plus a
// sanitiser plus a bundle for output that is already ours.
//
// Everything renders as text nodes; nothing is ever set as HTML, so a tool result
// that happens to contain markup is shown, not run.

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*)/g

function inline(text: string, key: string): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code
          key={`${key}-${i}`}
          style={{
            fontFamily: MONO,
            fontSize: '.88em',
            background: 'var(--field-2)',
            border: '1px solid var(--border-2)',
            padding: '1px 4px',
            color: 'var(--text)'
          }}
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) {
      return (
        <b key={`${key}-${i}`} style={{ color: 'var(--text)', fontWeight: 600 }}>
          {part.slice(2, -2)}
        </b>
      )
    }
    return <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>
  })
}

export function Md({
  src,
  color = 'var(--text-2)',
  size = 13.5
}: {
  src: string
  color?: string
  size?: number
}): React.ReactElement {
  const blocks: React.ReactNode[] = []
  const lines = src.split('\n')
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      blocks.push(
        <pre
          key={k++}
          style={{
            margin: '10px 0',
            padding: '10px 12px',
            background: 'var(--field)',
            border: '1px solid var(--border-2)',
            borderLeft: '2px solid var(--border)',
            fontFamily: MONO,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: 'var(--text)',
            // Wide content scrolls inside its own box; the log never scrolls
            // sideways as a whole.
            overflowX: 'auto'
          }}
        >
          {body.join('\n')}
        </pre>
      )
      continue
    }
    const heading = /^(#{1,4}) /.exec(line)
    if (heading) {
      blocks.push(
        <div
          key={k++}
          style={{
            margin: '14px 0 6px',
            fontSize: size + (heading[1].length <= 2 ? 0.5 : 0),
            fontWeight: 600,
            color: 'var(--text)'
          }}
        >
          {inline(line.slice(heading[1].length + 1), `h${k}`)}
        </div>
      )
      i++
      continue
    }
    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const items: string[] = []
      const ordered = /^\d+\. /.test(line)
      while (i < lines.length && (/^[-*] /.test(lines[i]) || /^\d+\. /.test(lines[i]))) {
        items.push(lines[i].replace(/^([-*]|\d+\.) /, ''))
        i++
      }
      blocks.push(
        <ul
          key={k++}
          style={{
            margin: '8px 0',
            paddingLeft: 20,
            listStyle: ordered ? 'decimal' : 'disc',
            color
          }}
        >
          {items.map((it, n) => (
            <li key={n} style={{ margin: '3px 0', lineHeight: 1.6 }}>
              {inline(it, `li${k}-${n}`)}
            </li>
          ))}
        </ul>
      )
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !/^#{1,4} /.test(lines[i]) &&
      !/^([-*]|\d+\.) /.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    blocks.push(
      <p key={k++} style={{ margin: '8px 0', lineHeight: 1.62, color }}>
        {inline(para.join(' '), `p${k}`)}
      </p>
    )
  }
  return <div style={{ fontSize: size }}>{blocks}</div>
}

/** hh:mm — the only timestamp format the log uses. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
