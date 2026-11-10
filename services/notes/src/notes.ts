/**
 * fleet-notes' notebooks: one for each box, kept as a file of its own in a
 * folder on the host, so that its notes outlast the box's processes and the
 * service's, as a file each, written whole. What a box sends is checked.
 * @module @sleepymug/fleet-notes/notes
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Note } from '@sleepymug/fleet-notes-box/wire'

/** What a notebook's name may be, as a file's name. */
const NOTEBOOK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export class Notebooks {
  /** @param folder - where each notebook is kept, as `<notebook>.json`, its notes oldest first. */
  constructor(private readonly folder: string) {}

  /** Keep a note in a notebook, and give it back. */
  add(notebook: string, text: unknown, tags: unknown = []): Note {
    if (typeof text !== 'string') throw new TypeError('add takes a text, a string')
    if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) throw new TypeError('add takes tags, a list of strings')
    const notes = this.read(notebook)
    const note: Note = { id: notes.length + 1, text, tags: [...tags as string[]], written: new Date().toISOString() }
    this.write(notebook, [...notes, note])
    return note
  }

  /** The notes of a notebook with a tag, oldest first. */
  byTag(notebook: string, tag: unknown): Note[] {
    if (typeof tag !== 'string') throw new TypeError('tag takes a tag, a string')
    return this.read(notebook).filter(note => note.tags.includes(tag))
  }

  /** A notebook's notes, oldest first; none before its first. */
  private read(notebook: string): Note[] {
    try {
      return JSON.parse(readFileSync(this.file(notebook), 'utf8')) as Note[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Keep a notebook's notes, whole or not at all. */
  private write(notebook: string, notes: Note[]): void {
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
