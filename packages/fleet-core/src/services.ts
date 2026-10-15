/**
 * The services fleet-core's plugins provide on dsh's context, as a plugin
 * that uses one declares it: `import type {} from '@sleepymug/fleet-core/services'`.
 * - `ctx.fleetExts`: the extensions provided (./ext/plugin.ts).
 * - `ctx.fleetTauRuns`: the runs of taus and their boxes (./tau/runs-plugin.ts),
 *   as the world uses them and as the tau service does (./tau/ports.ts).
 * - `ctx.fleetTau`: the tau service (./tau/plugin.ts).
 * - `ctx.fleetTauModel`: the model a tau's session starts on, as its config
 *   has it now (./tau/model-plugin.ts).
 * @module @sleepymug/fleet-core/services
 */

import type {} from '@deepseek-ai/cordis'
import type { FleetExts } from './ext/exts.ts'
import type { TauModelChoice } from './tau/model.ts'
import type { RunLifecycle, TauBoxes } from './tau/ports.ts'
import type { TauService } from './tau/service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetExts: FleetExts
    fleetTauRuns: TauBoxes & RunLifecycle
    fleetTau: TauService
    fleetTauModel: TauModelChoice
  }
}
