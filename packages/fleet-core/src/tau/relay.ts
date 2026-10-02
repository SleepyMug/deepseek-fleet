/**
 * Serves the calls programs in the containers make on fleet-box's service
 * socket with the fleet host's backends (./backends.ts). A call is served
 * only when an API of the container's session calls that backend: one its
 * agent links, as its spec records (./store.ts), or for a session not
 * started from an agent directory, such as one the web UI started, fleet's
 * `tau` (./apis.ts); any other is refused. The session is the one that owns
 * the container, which fleet-box knows from its connection to the
 * container, never from the call.
 * @module fleet-core/tau/relay
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../box/world.ts'
import { sessionApis } from './apis.ts'
import type {} from './backends.ts'
import type {} from './store.ts'

export const name = 'fleet-tau-relay'
export const inject = ['fleetBox', 'fleetTau', 'fleetBackends']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.fleetBox.serveCalls(async (owner, call, signal) => {
    const found = await ctx.fleetTau.specOf(await ctx.fleetBox.ownerHeaderOf(owner))
    if (!sessionApis(found?.spec).some(api => api.backends.includes(call.service))) {
      throw new Error(`this session has no API that calls the backend ${call.service}`)
    }
    return ctx.fleetBackends.call(owner, call, signal)
  }), 'fleet-tau backend relay')
}
