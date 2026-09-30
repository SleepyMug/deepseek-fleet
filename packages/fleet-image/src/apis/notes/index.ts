/**
 * A notebook of short notes, each with tags to find it by later. Each
 * session has a notebook of its own, which the fleet host keeps while it runs.
 *
 * @packageDocumentation
 */

import { call } from '../client.ts'

/** A saved note. */
export interface Note {
  readonly id: number
  text: string
  tags: string[]
  /** When it was written. */
  written: Date
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export async function addNote(text: string, tags: string[] = []): Promise<Note> {
  return revive(await call('notes', 'addNote', [text, tags]) as Kept)
}

/** Notes carrying `tag`, oldest first. */
export async function byTag(tag: string): Promise<Note[]> {
  return (await call('notes', 'byTag', [tag]) as Kept[]).map(revive)
}

/** A note as the fleet host keeps it, its date as ISO 8601 text. */
interface Kept {
  id: number
  text: string
  tags: string[]
  written: string
}

function revive(kept: Kept): Note {
  return { id: kept.id, text: kept.text, tags: [...kept.tags], written: new Date(kept.written) }
}
