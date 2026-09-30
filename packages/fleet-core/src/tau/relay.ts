/**
 * Serves the calls programs in the containers make on fleet-box's service
 * socket with the fleet host's backends (./backends.ts). A call is served
 * only when an API the agent of the container's session links calls that
 * backend, as its spec records (./store.ts); any other, as from a session the
 * web UI started, is refused. The session is the container's own, which
 * fleet-box knows from its connection to the container, never from the call.
 * @module fleet-core/tau/relay
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../box/world.ts'
import type {} from './backends.ts'
import type {} from './store.ts'

export const name = 'fleet-tau-relay'
export const inject = ['fleetBox', 'fleetTau', 'fleetBackends']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.fleetBox.serveCalls(async (root, call, signal) => {
    const found = await ctx.fleetTau.specOf(await ctx.fleetBox.rootHeaderOf(root))
    if (found?.spec.apis.some(api => api.backends.includes(call.service)) !== true) {
      throw new Error(`this session's agent links no API that calls the backend ${call.service}`)
    }
    return ctx.fleetBackends.call(root, call, signal)
  }), 'fleet-tau backend relay')
}
