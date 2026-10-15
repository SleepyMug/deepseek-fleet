/**
 * The model a tau's session runs on, as fleet-tau-model's config names it
 * for every run (./model-plugin.ts): a route, a provider and its model, and a
 * reasoning effort, each unset to follow dsh's default model, which a person
 * picks in the web UI. The `tau` preset applies it to each request of a
 * tau's session (../preset/model.ts). It knows nothing of dsh's.
 * @module @sleepymug/fleet-core/tau/model
 */

/** The model the service's sessions run on. */
export interface TauModel {
  /** The provider and its model; none for dsh's default. */
  route?: { provider: string; model: string }
  /** The reasoning effort, as the route's provider names it; none for the route's own, or, without a route, dsh's default's. */
  reasoningEffort?: string
}

/** The model as fleet-tau-model's config has it now, which may change while dsh runs; the `tau` preset reads it for each request. */
export interface TauModelChoice {
  current(): TauModel
}

/** The model the config's fields name, an empty field as one unset; a provider without its model, or a model without its provider, fails. */
export function tauModel(fields: { provider?: string | undefined; model?: string | undefined; reasoningEffort?: string | undefined }): TauModel {
  const provider = fields.provider || undefined
  const model = fields.model || undefined
  const reasoningEffort = fields.reasoningEffort || undefined
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('fleet-tau-model: provider and model are given together, or neither, for dsh\'s default model')
  }
  return {
    ...provider !== undefined && model !== undefined ? { route: { provider, model } } : {},
    ...reasoningEffort !== undefined ? { reasoningEffort } : {},
  }
}
