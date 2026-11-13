/**
 * fleet-notes' notebooks: one for each box, kept as a file of its own in a
 * folder where the server runs, so that its notes outlast the box's
 * processes and the server's, each written whole.
 * @module @sleepymug/fleet-notes/notebooks
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A note, as a notebook keeps it. */
export interface Kept {
  id: number
  text: string
  tags: string[]
  /** When it was kept, as an ISO date. */
  written: string
}

/** What a notebook's name may be, as a file's name. */
const NOTEBOOK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export class Notebooks {
  /** @param folder - where each notebook is kept, as `<notebook>.json`, its notes oldest first. */
  constructor(private readonly folder: string) {}

  /** Keep a note in a notebook, and give it back. */
  add(notebook: string, text: string, tags: readonly string[], now = new Date()): Kept {
    const notes = this.read(notebook)
    const note: Kept = { id: notes.length + 1, text, tags: [...tags], written: now.toISOString() }
    this.write(notebook, [...notes, note])
    return note
  }

  /** The notes of a notebook with a tag, oldest first. */
  tagged(notebook: string, tag: string): Kept[] {
    return this.read(notebook).filter(note => note.tags.includes(tag))
  }

  /** A notebook's notes, oldest first; none before its first. */
  private read(notebook: string): Kept[] {
    try {
      return JSON.parse(readFileSync(this.file(notebook), 'utf8')) as Kept[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Keep a notebook's notes, whole or not at all. */
  private write(notebook: string, notes: Kept[]): void {
    mkdirSync(this.folder, { recursive: true })
    const file = this.file(notebook)
    writeFileSync(`${file}.new`, `${JSON.stringify(notes)}\n`)
    renameSync(`${file}.new`, file)
  }

  private file(notebook: string): string {
    if (!NOTEBOOK.test(notebook)) throw new Error(`fleet-notes: no notebook named ${JSON.stringify(notebook)}`)
    return join(this.folder, `${notebook}.json`)
  }
}
