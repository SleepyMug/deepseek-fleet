/**
 * fleet-notes, a service of fleet's gateway, and the example of one: its
 * package, fleet-notes-box, which the gateway puts in each box, with the
 * `notes` command; and what serves each connection a box's command opens,
 * a request of the box's notebook (./notes.ts), named by the box the gateway
 * says the connection comes from, so a box reaches only its own.
 * @module @sleepymug/fleet-notes/service
 */

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { Socket } from 'node:net'
import type { ServiceDefinition } from '@sleepymug/fleet-sdk'
import { type Answer, type Request, SERVICE } from '@sleepymug/fleet-notes-box/wire'
import type { Notebooks } from './notes.ts'

/** What the service says it is. */
export const DESCRIPTION = 'A notebook of short notes, each with tags to find it by later, kept outside the box for as long as the box is: '
  + '`notes add <text> --tag <tag>`, `notes tag <tag>`.'

/** The service's package, which the gateway puts in each box. */
export const BOX_PACKAGE = dirname(createRequire(import.meta.url).resolve('@sleepymug/fleet-notes-box/package.json'))

/** The notes service, on `notebooks`, each box's notebook named by its id. */
export function notesService(notebooks: Notebooks): ServiceDefinition {
  return {
    name: SERVICE,
    description: DESCRIPTION,
    package: BOX_PACKAGE,
    serve(connection, from) {
      serveOne(connection, request => answer(notebooks, from.box, request))
    },
  }
}

/** A request's answer, for the box `box`'s notebook. */
export function answer(notebooks: Notebooks, box: string, request: unknown): unknown {
  const { op } = (request ?? {}) as Partial<Request>
  if (op === 'add') {
    const { text, tags } = request as Request & { op: 'add' }
    return notebooks.add(box, text, tags)
  }
  if (op === 'tag') return notebooks.byTag(box, (request as Request & { op: 'tag' }).tag)
  throw new Error(`no op ${String(op)}`)
}

/** Read one line of JSON, the request, and answer it with one, closing the connection. */
function serveOne(connection: Socket, handle: (request: unknown) => unknown): void {
  let text = ''
  connection.setEncoding('utf8')
  connection.on('error', () => {})
  connection.on('data', (chunk: string) => { text += chunk })
  connection.on('end', () => {
    let reply: Answer
    try {
      reply = { ok: true, value: handle(JSON.parse(text)) }
    } catch (error) {
      reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    connection.end(`${JSON.stringify(reply)}\n`)
  })
}
