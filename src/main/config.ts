import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import type { Config, Project } from '@shared/types'

// Single JSON file under %APPDATA%/vivarium/config.json (ref: plan). Runtime
// state (container running?, live ptys) is NOT stored here — it is queried live.

const EMPTY: Config = { version: 1, projects: [] }

export class ConfigStore {
  private path: string
  private cache: Config = EMPTY

  constructor() {
    // app.getPath('userData') resolves to %APPDATA%/vivarium on Windows (the
    // product name), which is exactly where we want config.json.
    this.path = join(app.getPath('userData'), 'config.json')
  }

  get filePath(): string {
    return this.path
  }

  async load(): Promise<Config> {
    try {
      const raw = await fs.readFile(this.path, 'utf-8')
      const parsed = JSON.parse(raw) as Config
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects)) {
        this.cache = EMPTY
      } else {
        this.cache = parsed
      }
    } catch {
      // Missing/corrupt file → start empty.
      this.cache = EMPTY
    }
    return this.cache
  }

  get(): Config {
    return this.cache
  }

  getProject(id: string): Project | undefined {
    return this.cache.projects.find((p) => p.id === id)
  }

  async save(config: Config): Promise<void> {
    this.cache = config
    await fs.mkdir(dirname(this.path), { recursive: true })
    // Atomic write: temp file + rename so a crash mid-write can't corrupt config.
    const tmp = `${this.path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8')
    await fs.rename(tmp, this.path)
  }

  async mutate(fn: (config: Config) => Config): Promise<Config> {
    const next = fn(structuredClone(this.cache))
    await this.save(next)
    return next
  }
}
