/**
 * The client of @sleepymug/tau-api-notes: a notebook of short notes, each
 * with tags to find them by later, which its server keeps on the fleet host,
 * one for each session, so every program of the session sees the same
 * notebook.
 * @module @sleepymug/fleet-ext-notes/client
 */

import { call } from '@sleepymug/fleet-box-runtime/ext/client'
import type { Note } from '@sleepymug/tau-api-notes'
import { CONTRACT } from './contract.ts'

/** A note as it crosses to the host and back. */
interface WireNote {
  id: number
  text: string
  tags: string[]
  written: string
}

export async function addNote(text: string, tags: readonly string[] = []): Promise<Note> {
  return note(await call(CONTRACT, 'addNote', [text, tags]) as WireNote)
}

export async function byTag(tag: string): Promise<Note[]> {
  return (await call(CONTRACT, 'byTag', [tag]) as WireNote[]).map(note)
}

function note(wire: WireNote): Note {
  return { ...wire, written: new Date(wire.written) }
}
