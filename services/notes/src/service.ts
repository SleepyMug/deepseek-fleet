/**
 * The notes service, as fleet-sdk serves it to the gateway: its schema
 * (proto/notes/v1/notes.proto), and its calls, each answered from the
 * notebook of the box it comes from, as the gateway says, so that a box
 * reaches its own notebook alone.
 * @module @sleepymug/fleet-notes/service
 */

import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError } from '@connectrpc/connect'
import { boxOf, type ServiceDefinition } from '@sleepymug/fleet-sdk'
import { descriptors } from './gen/descriptors.ts'
import { type Note, NoteSchema, Notes } from './gen/notes/v1/notes_pb.ts'
import type { Kept, Notebooks } from './notebooks.ts'

export { Notes }

/** What the service says it is, for the box's README. */
export const DESCRIPTION = 'A notebook of short notes for this box, each with tags to find it by later, which outlasts the box\'s processes.'

/** The notes service, its notebooks `notebooks`. */
export function notesService(notebooks: Notebooks): ServiceDefinition {
  return {
    name: 'notes',
    description: DESCRIPTION,
    schema: descriptors(),
    services: [Notes],
    routes: router => router.service(Notes, {
      add: (req, ctx) => {
        if (req.text.trim() === '') throw new ConnectError('notes: a note says something', Code.InvalidArgument)
        return noteOf(notebooks.add(boxOf(ctx).id, req.text, req.tags))
      },
      tagged: (req, ctx) => ({ notes: notebooks.tagged(boxOf(ctx).id, req.tag).map(noteOf) }),
    }),
  }
}

function noteOf(kept: Kept): Note {
  return create(NoteSchema, { id: kept.id, text: kept.text, tags: kept.tags, written: timestampFromDate(new Date(kept.written)) })
}
