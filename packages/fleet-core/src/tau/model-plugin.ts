/**
 * fleet-tau-model, the model every tau's session runs on (./model.ts), as a
 * dsh plugin that provides it as `ctx.fleetTauModel`, for the `tau` preset
 * (../preset/model.ts). Its config is the model's fields alone, so a profile's
 * patch, which replaces a row's whole config, or dsh's settings, set them
 * without restating anything else; each is volatile, so a change reaches each
 * session's next request, and nothing is mounted again. It needs nothing.
 * @module @sleepymug/fleet-core/tau/model-plugin
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../services.ts'
import { tauModel } from './model.ts'
import type { TauModel } from './model.ts'

export const name = 'fleet-tau-model'

export interface Config {
  /** The provider of the model a tau's session runs on, with `model`; unset for dsh's default model. */
  provider: Volatile<string | undefined>
  /** The model a tau's session runs on, the provider's id of it, with `provider`. */
  model: Volatile<string | undefined>
  /** The reasoning effort a tau's session runs with, as the provider names it; unset for the model's own, or dsh's default's. */
  reasoningEffort: Volatile<string | undefined>
}

export const Config = z.object({
  provider: z.string().volatile(),
  model: z.string().volatile(),
  reasoningEffort: z.string().volatile(),
})

export function apply(ctx: Context, config: Config): void {
  const current = (): TauModel => tauModel({
    provider: config.provider.get(),
    model: config.model.get(),
    reasoningEffort: config.reasoningEffort.get(),
  })
  // A wrong model fails the plugin as it loads; one changed later, each request of a tau's session.
  current()
  ctx.provide('fleetTauModel', { current })
}
