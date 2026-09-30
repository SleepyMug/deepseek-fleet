/**
 * An example backend, `notes`: a notebook per session, kept in the fleet
 * host's memory until it exits, for fleet's implementation of the `notes`
 * API (fleet-image's apis/), which programs in the container import. It shows what a
 * backend plugin looks like; fleet-runtime's patch lists it disabled. An agent
 * directory with a copy of the API in its api/ can use it, as examples/notes
 * in this repository does.
 * @module fleet-runtime/tau/examples/notes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { method } from '../backends.ts'

export const name = 'fleet-tau-notes'
export const inject = ['fleetBackends']

/** A note as the implementation takes it back: its date as ISO 8601 text. */
interface Note {
  id: number
  text: string
  tags: string[]
  written: string
}

export function apply(ctx: Context): void {
  const notebooks = new Map<SessionId, Note[]>()
  const notebook = (session: SessionId): Note[] => {
    let notes = notebooks.get(session)
    if (notes === undefined) notebooks.set(session, notes = [])
    return notes
  }
  const dispose = ctx.fleetBackends.provide({
    name: 'notes',
    methods: {
      addNote: method(z.tuple([z.string(), z.array(z.string())]), ([text, tags], { session }) => {
        const notes = notebook(session)
        const note: Note = { id: notes.length + 1, text, tags, written: new Date().toISOString() }
        notes.push(note)
        return { ...note }
      }),
      byTag: method(z.tuple([z.string()]), ([tag], { session }) => notebook(session).filter(note => note.tags.includes(tag)).map(note => ({ ...note }))),
    },
  })
  ctx.effect(() => dispose, 'the notes backend')
}
