/**
 * The services dsh-tau's plugins provide on dsh's context, as a plugin that
 * uses one declares it: `import type {} from '@sleepymug/dsh-tau/services'`.
 * - `ctx.fleetClient`: the fleet host's client (./tau/runs-plugin.ts), whose
 *   connection the runs' boxes, and the tau service, are held on.
 * - `ctx.fleetTauRuns`: the runs of taus and their boxes (./tau/runs-plugin.ts),
 *   as the world uses them and as the tau backend does (./tau/ports.ts).
 * - `ctx.fleetTau`: the tau backend (./tau/plugin.ts).
 * - `ctx.fleetTauModel`: the model a tau's session starts on, as its config
 *   has it now (./tau/model-plugin.ts).
 * @module @sleepymug/dsh-tau/services
 */

import type {} from '@deepseek-ai/cordis'
import type { FleetClient } from '@sleepymug/fleet-client'
import type { TauModelChoice } from './tau/model.ts'
import type { RunLifecycle, TauBoxes } from './tau/ports.ts'
import type { TauService } from './tau/service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetClient: FleetClient
    fleetTauRuns: TauBoxes & RunLifecycle
    fleetTau: TauService
    fleetTauModel: TauModelChoice
  }
}
