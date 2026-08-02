import React from 'react'
import { CHAT, MONO } from '../../theme'

// Enough markdown for a conversation: headings, bullets, ordered lists, fenced
// code, `inline code` and **bold**. Deliberately small — this is a personal tool
// reading Claude Code's own prose, and a full parser is a dependency plus a
// sanitiser plus a bundle for output that is already ours.
//
// Everything renders as text nodes; nothing is ever set as HTML, so a tool result
// that happens to contain markup is shown, not run.
//
// Type is set to the redesign: 14.5px at 1.68, `CHAT.prose` rather than white,
// and `text-wrap: pretty` so the last line of a paragraph never leaves one word
// alone. Lists drop the browser marker for a coral en-dash in the gutter of the
// item, which is the one place the accent appears inside Claude's own prose.

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*)/g

function inline(text: string, key: string): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code
          key={`${key}-${i}`}
          style={{
            fontFamily: MONO,
            fontSize: '.86em',
            background: CHAT.card,
            border: `1px solid ${CHAT.borderCard}`,
            padding: '1px 5px',
            color: CHAT.text
          }}
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) {
      return (
        <b key={`${key}-${i}`} style={{ color: CHAT.text, fontWeight: 600 }}>
          {part.slice(2, -2)}
        </b>
      )
    }
    return <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>
  })
}

export function Md({
  src,
  color = CHAT.prose,
  size = 14.5
}: {
  src: string
  color?: string
  size?: number
}): React.ReactElement {
  const blocks: React.ReactNode[] = []
  const lines = src.split('\n')
  let i = 0
  let k = 0
  const spaced = (node: React.ReactNode, key: number): React.ReactNode => (
    <div key={key} style={{ marginBottom: 14 }}>
      {node}
    </div>
  )
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      blocks.push(
        spaced(
          <pre
            style={{
              margin: 0,
              padding: '11px 13px',
              background: CHAT.card,
              border: `1px solid ${CHAT.borderCard}`,
              fontFamily: MONO,
              fontSize: 12,
              lineHeight: 1.6,
              color: CHAT.prose,
              // Wide content scrolls inside its own box; the log never scrolls
              // sideways as a whole.
              overflowX: 'auto'
            }}
          >
            {body.join('\n')}
          </pre>,
          k++
        )
      )
      continue
    }
    const heading = /^(#{1,4}) /.exec(line)
    if (heading) {
      blocks.push(
        spaced(
          <div
            style={{
              fontSize: size + (heading[1].length <= 2 ? 0.5 : 0),
              fontWeight: 600,
              color: CHAT.text,
              lineHeight: 1.5
            }}
          >
            {inline(line.slice(heading[1].length + 1), `h${k}`)}
          </div>,
          k++
        )
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
        spaced(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {items.map((it, n) => (
              <div key={n} style={{ display: 'flex', gap: 10, lineHeight: 1.62 }}>
                <span
                  style={{
                    flex: 'none',
                    color: CHAT.you,
                    fontFamily: MONO,
                    fontSize: 12,
                    paddingTop: 1
                  }}
                >
                  {ordered ? `${n + 1}.` : '–'}
                </span>
                <span style={{ color }}>{inline(it, `li${k}-${n}`)}</span>
              </div>
            ))}
          </div>,
          k++
        )
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
      spaced(
        <div style={{ lineHeight: 1.68, color, textWrap: 'pretty' } as React.CSSProperties}>
          {inline(para.join(' '), `p${k}`)}
        </div>,
        k++
      )
    )
  }
  // The last block owns no trailing margin: the row's own padding is the gap to
  // whatever comes next, and doubling them made every message look orphaned.
  return (
    <div style={{ fontSize: size, marginBottom: -14 }}>{blocks}</div>
  )
}

/** hh:mm — the only timestamp format the log uses. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
