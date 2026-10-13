/**
 * `ctx.spillStore` of a host fleet-core is installed in: dsh's own local
 * store, which this service mounts where only it sees it, with its config,
 * as dsh-base's `spill-local` row has it, for every session that is not a
 * tau's. A tau's session's is refused: a spill file would sit on the host,
 * where its model, whose files are its box's, cannot read it, so dsh keeps
 * the whole result in the conversation instead, as it does when a store
 * fails.
 * @module @sleepymug/fleet-core/world/spill
 */

import type { Context } from '@deepseek-ai/cordis'
import { SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import type { Config } from '@deepseek-ai/dsh-spill-local'
import type {} from '../services.ts'

export type { Config }

export class FleetSpillStore extends SpillStore {
  static inject = ['fleetTauRuns']

  private readonly self: Context
  /** dsh's local store, for every session that is not a tau's. */
  private readonly local: Promise<SpillStore>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.self = ctx
    // Mounted where only this service sees it, so that it does not stand in for this one.
    const isolated = ctx.isolate('spillStore')
    this.local = (async () => {
      await isolated.plugin(LocalSpillStore, config ?? {})
      return isolated.get('spillStore') as SpillStore
    })()
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const session = input.owner.sessionId
    if (this.self.fleetTauRuns.isTau(session)) throw new Error(`${session} is a tau's session, whose files are its box's, so it has no spill files`)
    return (await this.local).saveText(input)
  }
}

export default FleetSpillStore
