/**
 * The tau service's registry: which box each session has, and what its run
 * needs, one JSON file per session in a folder of its own. The service writes
 * an entry once the session's box is set up, so an entry means a box ready to
 * start.
 * @module fleet-core/tau/registry
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BoundHandle } from '@sleepymug/tau'

/** The ids the service mints: `session-` and a UUID, the form dsh's sessions take. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export interface Entry {
  sessionId: string
  /** The box's container. */
  box: string
  tauDir: string
  /** The tau's prompt, expanded with where the box has each handle. */
  prompt: string
  /** Each handle of the run: its mode, its kind, the caller's path, and where the box has it. */
  handles: readonly BoundHandle[]
  /** The APIs the tau declares, by name; nothing implements them yet. */
  apis: readonly string[]
  createdAt: string
}

export class Registry {
  /** @param dir - the folder of the entries, made when the first is written. */
  constructor(private readonly dir: string) {}

  /** Write a session's entry, whole or not at all. */
  async put(entry: Entry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = this.file(entry.sessionId)
    await writeFile(`${file}.tmp`, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }

  /** A session's entry; a session without one fails. */
  async get(sessionId: string): Promise<Entry> {
    try {
      return JSON.parse(await readFile(this.file(sessionId), 'utf8')) as Entry
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`fleet: no tau session ${sessionId}`)
      throw error
    }
  }

  /** Forget a session; one without an entry is forgotten already. */
  async delete(sessionId: string): Promise<void> {
    await rm(this.file(sessionId), { force: true })
  }

  /** An entry's file, for an id of the form the service mints, which is what makes it a file name. */
  private file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`fleet: no tau session ${sessionId}`)
    return join(this.dir, `${sessionId}.json`)
  }
}
