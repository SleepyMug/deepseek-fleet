/**
 * The tau service, which the tau backend serves through fleet's gateway
 * (./plugin.ts): `tau.v1.Runs`, its schema tau's own, with its comments,
 * so the gateway gives every box a client of it, `@fleet/tau`; its package,
 * tau itself, whose `tau` command every box has on its PATH, told by the
 * service's environment to run taus through the box's services socket; and
 * its calls, each served for who the gateway says makes it: from a box, the
 * session whose box it is, which reaches only the runs it started; from a
 * client of the gateway, such as the host's `tau` command, the host, which
 * reaches every run.
 * @module @sleepymug/dsh-tau/tau/tau-service
 */

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { Code, ConnectError } from '@connectrpc/connect'
import { callerOf, type ServiceDefinition } from '@sleepymug/fleet-sdk'
import { BOX_LAYOUT } from '@sleepymug/fleet-protocol/layout'
import { servicePath } from '@sleepymug/fleet-protocol/wire'
import { descriptors, Runs, type RunBackend, runsRoutes } from '@sleepymug/tau/rpc'
import { HOST, type Caller } from './registry.ts'

/** The service's name, and so its path through the gateway, `/services/tau`, and its client, `@fleet/tau`. */
export const SERVICE = 'tau'

/** What the tau service says it is, for whoever lists the services, and a tau's session's prompt. */
export const DESCRIPTION = 'Runs TAUs, each in a box of its own, as this box\'s run, which waits for each: '
  + '`tau run <dir> --call-json \'<call>\' --json`, as /tau/TAU.md says.'

/** The tau service's package, which the gateway puts in every box: tau, as installed beside this package. */
export const TAU_PACKAGE = dirname(createRequire(import.meta.url).resolve('@sleepymug/tau/package.json'))

/** What the tau command in a box finds its backend by: the rpc adaptor, through the box's services socket, at the service's path. */
export const SERVICE_ENV = { TAU_ADAPTOR: 'rpc', TAU_RPC_SOCKET: BOX_LAYOUT.servicesSocket, TAU_RPC_PATH: servicePath(SERVICE) }

/**
 * The tau service, each call served by `backendFor` the caller: the host
 * for a client of the gateway, the session whose box `sessionOfBox` says a
 * box is for a call from it; a call from a box that is no run's is refused.
 */
export function tauService(sessionOfBox: (box: string) => string | undefined, backendFor: (caller: Caller) => RunBackend): ServiceDefinition {
  return {
    name: SERVICE,
    description: DESCRIPTION,
    schema: descriptors(),
    services: [Runs],
    package: TAU_PACKAGE,
    env: SERVICE_ENV,
    routes: runsRoutes((context) => {
      const { caller } = callerOf(context)
      if (caller.case !== 'box') return backendFor(HOST)
      const sessionId = sessionOfBox(caller.value.id)
      if (sessionId === undefined) throw new ConnectError('dsh-tau: this box is no tau run\'s, so it runs no taus', Code.PermissionDenied)
      return backendFor({ kind: 'session', sessionId })
    }),
  }
}
