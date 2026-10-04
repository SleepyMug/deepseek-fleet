/**
 * The server of the notes API: each session's notebook, kept in dsh's
 * process for as long as it runs. Its methods take what the client in the
 * box sends, so they check it.
 * @module fleet-ext-notes/notes
 */

import type { ExtMethod } from 'fleet-core/ext/plugin'

interface Note {
  id: number
  text: string
  tags: string[]
  /** When it was written, as an ISO date, which the client turns into a Date. */
  written: string
}

export class Notebooks {
  /** Each session's notes, oldest first. */
  private readonly notes = new Map<string, Note[]>()

  readonly methods: Record<string, ExtMethod> = {
    addNote: ([text, tags = []], { sessionId }) => {
      if (typeof text !== 'string') throw new TypeError('addNote takes a text, a string')
      if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) throw new TypeError('addNote takes tags, a list of strings')
      let notes = this.notes.get(sessionId)
      if (notes === undefined) this.notes.set(sessionId, notes = [])
      const note: Note = { id: notes.length + 1, text, tags: [...tags as string[]], written: new Date().toISOString() }
      notes.push(note)
      return note
    },
    byTag: ([tag], { sessionId }) => {
      if (typeof tag !== 'string') throw new TypeError('byTag takes a tag, a string')
      return (this.notes.get(sessionId) ?? []).filter(note => note.tags.includes(tag))
    },
  }
}
