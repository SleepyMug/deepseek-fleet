/**
 * How the notes command in a box (./notes.ts) and fleet-notes on the host
 * talk, over the service's socket in the box, which fleet's gateway relays:
 * one request a connection, a line of JSON, and one answer, a line of JSON.
 * Shared by both ends, so it holds only types.
 * @module @sleepymug/fleet-notes-box/wire
 */

/** What the notes command asks. */
export type Request =
  /** Keep a note in the box's notebook. Answers the note. */
  | { op: 'add'; text: string; tags: string[] }
  /** The box's notes with a tag, oldest first. */
  | { op: 'tag'; tag: string }

/** A note, as it is kept. */
export interface Note {
  /** Its number, which no other note of its notebook has. */
  id: number
  text: string
  tags: string[]
  /** When it was kept, as an ISO date. */
  written: string
}

/** What a request is answered with: its value, or why it failed. */
export type Answer = { ok: true; value: unknown } | { ok: false; error: string }

/** The name the service registers under, and so its socket's in a box. */
export const SERVICE = 'notes'
