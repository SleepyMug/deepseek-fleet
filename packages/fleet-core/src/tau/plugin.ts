/**
 * fleet-tau, the tau service (./service.ts) on its socket (./server.ts), as
 * a dsh plugin: fleet-core's cordis.patch.yml mounts it in the fleet
 * profile. It runs in dsh's process, but uses nothing of dsh's: its config
 * names the dsh home, where it serves its socket and keeps its registry, its
 * boxes are Docker's, and it prints what it does on dsh's stderr.
 * @module fleet-core/tau/plugin
 */

import { isAbsolute, join } from 'node:path'
import { socketPath } from 'fleet-protocol/tau'
import { Registry } from './registry.ts'
import { listen } from './server.ts'
import { TauService } from './service.ts'

export const name = 'fleet-tau'

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
}

/** What the plugin uses of the cordis context it is given, so that it imports nothing of dsh's. */
interface PluginContext {
  effect(execute: () => () => Promise<void>, label?: string): unknown
}

export async function apply(ctx: PluginContext, config: Config): Promise<void> {
  if (typeof config?.dshHome !== 'string' || !isAbsolute(config.dshHome)) {
    throw new Error('fleet-tau: its config names dshHome, the dsh home, an absolute path')
  }
  // On dsh's stderr, beside its own `dsh:` lines: its logger shows no info.
  const print = (message: string): void => { process.stderr.write(`fleet-tau: ${message}\n`) }
  const service = new TauService(new Registry(join(config.dshHome, 'fleet', 'taus')), print)
  const close = await listen(socketPath(config.dshHome), service)
  try {
    ctx.effect(() => async () => {
      await close()
      await service.close()
    }, 'fleet-tau socket')
  } catch (error) {
    // Unloaded while it started, so nothing else would close the socket.
    await close()
    throw error
  }
}
