import { app, clipboard } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

// Replaces the reference script's TCP clipboard-bridge hack. On Ctrl+V in an
// agent session the renderer asks us for an image; if the Windows clipboard
// holds one, we write it as PNG into the project's clip dir (bind-mounted at
// /clip in the container) and return the container-side path for the renderer
// to type into the pty. Text paste is handled by xterm directly.

let counter = 0

export async function pasteImage(projectId: string): Promise<string | null> {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null

  const png = image.toPNG()
  if (!png || png.length === 0) return null

  const dir = join(app.getPath('userData'), 'clip', projectId)
  await fs.mkdir(dir, { recursive: true })

  counter += 1
  const filename = `clip-${Date.now()}-${counter}.png`
  await fs.writeFile(join(dir, filename), png)

  // Container-side path (dir is bind-mounted at /clip).
  return `/clip/${filename}`
}
