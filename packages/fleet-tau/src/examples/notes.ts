/**
 * An example service, `notes` (manifests/notes.d.ts): a notebook per session,
 * kept in the fleet host's memory until it exits. It shows what a provider
 * plugin looks like; fleet-tau's patch lists it disabled. An agent directory
 * with a copy of the manifest in its api/ can call it, as examples/notes in
 * this repository does.
 * @module fleet-tau/examples/notes
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '../services.ts'

export const name = 'fleet-tau-notes'
export const inject = ['fleetServices']

interface Note {
  id: number
  text: string
  tags: string[]
}

export async function apply(ctx: Context): Promise<void> {
  const notebooks = new Map<SessionId, Note[]>()
  const notebook = (session: SessionId): Note[] => {
    let notes = notebooks.get(session)
    if (notes === undefined) notebooks.set(session, notes = [])
    return notes
  }
  const dispose = await ctx.fleetServices.provide({
    manifest: fileURLToPath(new URL('../../manifests/notes.d.ts', import.meta.url)),
    functions: {
      addNote: ([text, tags], { session }) => {
        const notes = notebook(session)
        const note: Note = { id: notes.length + 1, text: text as string, tags: (tags as string[] | undefined) ?? [] }
        notes.push(note)
        return { ...note }
      },
      byTag: ([tag], { session }) => notebook(session).filter(note => note.tags.includes(tag as string)).map(note => ({ ...note })),
    },
  })
  ctx.effect(() => dispose, 'the notes service')
}
