/**
 * The server of @sleepymug/tau-api-notes: each session's notebook, kept as a
 * file of its own in a folder on the host, so that its notes persist, as the
 * contract has them, while dsh restarts. Its methods take what the client in
 * the box sends, so they check it.
 * @module @sleepymug/fleet-ext-notes/notes
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtMethod } from '@sleepymug/fleet-core/ext/plugin'

interface Note {
  id: number
  text: string
  tags: string[]
  /** When it was written, as an ISO date, which the client turns into a Date. */
  written: string
}

/** What a session's id may be, as a file's name. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export class Notebooks {
  /** @param folder - where each session's notebook is kept, as `<session>.json`, its notes oldest first. */
  constructor(private readonly folder: string) {}

  readonly methods: Record<string, ExtMethod> = {
    addNote: ([text, tags = []], { sessionId }) => {
      if (typeof text !== 'string') throw new TypeError('addNote takes a text, a string')
      if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) throw new TypeError('addNote takes tags, a list of strings')
      const notes = this.read(sessionId)
      const note: Note = { id: notes.length + 1, text, tags: [...tags as string[]], written: new Date().toISOString() }
      this.write(sessionId, [...notes, note])
      return note
    },
    byTag: ([tag], { sessionId }) => {
      if (typeof tag !== 'string') throw new TypeError('byTag takes a tag, a string')
      return this.read(sessionId).filter(note => note.tags.includes(tag))
    },
  }

  /** A session's notes, oldest first; none before its first. */
  private read(sessionId: string): Note[] {
    try {
      return JSON.parse(readFileSync(this.file(sessionId), 'utf8')) as Note[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Keep a session's notes, whole or not at all. */
  private write(sessionId: string, notes: Note[]): void {
    mkdirSync(this.folder, { recursive: true })
    const file = this.file(sessionId)
    writeFileSync(`${file}.new`, `${JSON.stringify(notes)}\n`)
    renameSync(`${file}.new`, file)
  }

  private file(sessionId: string): string {
    if (!SESSION.test(sessionId)) throw new Error(`fleet-ext-notes: no notebook for a session named ${JSON.stringify(sessionId)}`)
    return join(this.folder, `${sessionId}.json`)
  }
}
