/**
 * A notebook of short notes, each with tags to find it by later. The notes
 * are the session's, kept on the fleet host, so every program of the
 * session sees the same notebook.
 *
 * @packageDocumentation
 */

import { call } from 'fleet-box-runtime/ext/client'

/** A saved note. */
export interface Note {
  readonly id: number
  text: string
  tags: string[]
  written: Date
}

/** A note as it crosses to the host and back. */
interface WireNote {
  id: number
  text: string
  tags: string[]
  written: string
}

/**
 * Remember something, and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export async function addNote(text: string, tags: string[] = []): Promise<Note> {
  return note(await call('notes', 'addNote', [text, tags]) as WireNote)
}

/** The notes carrying `tag`, oldest first. */
export async function byTag(tag: string): Promise<Note[]> {
  return (await call('notes', 'byTag', [tag]) as WireNote[]).map(note)
}

function note(wire: WireNote): Note {
  return { ...wire, written: new Date(wire.written) }
}
