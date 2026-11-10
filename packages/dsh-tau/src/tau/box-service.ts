/**
 * The tau service, which the tau backend registers with the fleet host
 * (./plugin.ts): its package, dsh-tau-box, which the host puts in every box,
 * with the `tau` command, whose runs go to the backend, and dsh-tau's half
 * of a run's box; and what serves its connections, each one from a box,
 * which the host says, the box's run's, whose session is the caller of the
 * runs it makes, and reaches only those.
 * @module @sleepymug/dsh-tau/tau/box-service
 */

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { ServiceDefinition } from '@sleepymug/fleet-client'
import { SERVICE } from '@sleepymug/dsh-tau-box/layout'
import { socketOf } from '@sleepymug/fleet-protocol/layout'
import { type RequestHandler, serveConnection } from '@sleepymug/tau/adaptors'
import type { Caller } from './registry.ts'

/** What the tau service says it is, for whoever lists the services, and a tau's session's prompt. */
export const DESCRIPTION = 'Runs TAUs, each in a box of its own, as this box\'s run, which waits for each: '
  + '`tau run <dir> --call-json \'<call>\' --json`, as /tau/TAU.md says.'

/** The tau service's package, which the fleet host puts in every box: dsh-tau-box, as installed beside this one. */
export const BOX_PACKAGE = dirname(createRequire(import.meta.url).resolve('@sleepymug/dsh-tau-box/package.json'))

/** What the tau command in a box finds its backend by: the socket adaptor, on the service's socket there. */
export const SERVICE_ENV = { TAU_ADAPTOR: 'socket', TAU_SOCKET: socketOf(SERVICE) }

/** What a connection from a box that is no run's is answered with. */
const refuse: RequestHandler = () => Promise.reject(new Error('dsh-tau: this box is no tau run\'s, so it runs no taus'))

/**
 * The tau service, its connections served for the session whose box each
 * comes from, with `handlerFor` that session's requests.
 */
export function tauService(sessionOfBox: (box: string) => string | undefined, handlerFor: (caller: Caller) => RequestHandler): ServiceDefinition {
  return {
    name: SERVICE,
    description: DESCRIPTION,
    package: BOX_PACKAGE,
    env: SERVICE_ENV,
    serve(connection, from) {
      // The host says which box a connection comes from; a run's are its session's.
      const sessionId = sessionOfBox(from.box)
      serveConnection(connection, sessionId === undefined ? refuse : handlerFor({ kind: 'session', sessionId }))
    },
  }
}
