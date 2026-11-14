/**
 * The boxes the gateway made, one JSON file each in its home's `boxes/`,
 * so that a gateway started later knows them: what each was made with,
 * which is fixed once it is made, its services among it. Whether its
 * container is there, and runs, is its driver's to say.
 * @module @sleepymug/fleet/boxes/registry
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BOX_ID } from '@sleepymug/fleet-protocol/wire'

/** A service of a box: its name, and its spec as it was when the box was made. */
export interface BoxService {
  name: string
  spec: string
}

/** A box, as the gateway made it. */
export interface BoxRecord {
  /** Its id, which names its container. */
  id: string
  image: string
  labels: Record<string, string>
  /** The environment of every process in it, its services' and its creator's. */
  env: Record<string, string>
  services: BoxService[]
  /** When it was made, as an ISO date. */
  createdAt: string
}

export class Registry {
  /** @param dir - the folder of the records, made when the first is written. */
  constructor(private readonly dir: string) {}

  async list(): Promise<BoxRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const ids = names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)).filter(id => BOX_ID.test(id))
    const records = await Promise.all(ids.map(id => this.get(id)))
    return records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  async get(id: string): Promise<BoxRecord> {
    return JSON.parse(await readFile(this.file(id), 'utf8')) as BoxRecord
  }

  /** Write a record whole, or not at all. */
  async put(record: BoxRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = this.file(record.id)
    await writeFile(`${file}.new`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await rename(`${file}.new`, file)
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true })
  }

  private file(id: string): string {
    if (!BOX_ID.test(id)) throw new Error(`fleet: no box ${id}`)
    return join(this.dir, `${id}.json`)
  }
}
