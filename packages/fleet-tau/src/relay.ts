/**
 * Serves the service calls programs in the containers make (fleet-box's
 * service socket) with the services fleet provides (./services.ts). A call
 * is served only when the agent of the container's session declares it in
 * its spec (./store.ts); any other, as from a session the web UI started,
 * is refused. The session is the container's own, which fleet-box knows from
 * its connection to the container, never from the call.
 * @module fleet-tau/relay
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from 'fleet-box/world'
import type {} from './services.ts'
import type {} from './store.ts'

export const name = 'fleet-tau-relay'
export const inject = ['fleetBox', 'fleetTau', 'fleetServices']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.fleetBox.serveCalls(async (root, call, signal) => {
    const found = await ctx.fleetTau.specOf(await ctx.fleetBox.rootHeaderOf(root))
    const services = found?.spec.services ?? {}
    if (!Object.hasOwn(services, call.service) || !services[call.service]!.functions.includes(call.function)) {
      throw new Error(`this session's agent does not declare ${call.service}.${call.function}`)
    }
    return ctx.fleetServices.call(root, call, signal)
  }), 'fleet-tau service relay')
}
