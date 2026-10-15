/**
 * What the tau model page offers, from dsh's model catalog, the one the
 * chat box's model picker offers (`remote.session.modelCatalog()`): the
 * models by provider, and the reasoning efforts of the chosen one. A route
 * fleet-tau-model's config names that the catalog no longer has stays
 * offered, as unavailable, so the page shows what is saved.
 * @module @sleepymug/fleet-core/client/catalog
 */

import type { ModelCatalog, ModelReasoningEffort } from '@deepseek-ai/dsh-api-remotes/client'

/** A provider and its model, as fleet-tau-model's config names them. */
export interface Route {
  readonly provider: string
  readonly model: string
}

/** fleet-tau-model's config, as dsh's settings serve it. */
export interface TauModelValue {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
}

/** One model the page offers. */
export interface ModelChoice {
  /** The option's value, which names its route. */
  readonly key: string
  readonly route: Route
  /** Its name, as the chat box shows it, or its route if the catalog has it no longer. */
  readonly name: string
}

/** One provider's models. */
export interface ProviderChoices {
  readonly provider: string
  readonly name: string
  readonly models: readonly ModelChoice[]
}

/** The reasoning efforts of a model, as the chat box offers them. */
export interface Efforts {
  readonly efforts: readonly ModelReasoningEffort[]
  /** The id of the model's own; none if its provider names none. */
  readonly defaultEffort?: string | undefined
}

/** The models the page offers, and dsh's default. */
export interface Choices {
  readonly groups: readonly ProviderChoices[]
  /** The saved route, if the catalog does not have it. */
  readonly unavailable?: ModelChoice | undefined
  /** dsh's default model, which a tau's session starts on without a route, and its name, if the catalog has it. */
  readonly defaultModel?: { readonly route: Route, readonly name: string } | undefined
}

/** The route a config names; none for dsh's default, as for a provider without its model. */
export function routeOf(value: TauModelValue | undefined): Route | null {
  return value?.provider && value.model ? { provider: value.provider, model: value.model } : null
}

/** The option value of a route. */
export function routeKey(route: Route): string {
  return JSON.stringify([route.provider, route.model])
}

export function sameRoute(a: Route | null, b: Route | null): boolean {
  return a === null || b === null ? a === b : a.provider === b.provider && a.model === b.model
}

/** What the page offers, `saved` among it whether the catalog has it or not. */
export function choicesOf(catalog: ModelCatalog | undefined, saved: Route | null): Choices {
  const groups = (catalog?.groups ?? []).filter(group => group.models.length > 0).map(group => ({
    provider: group.id,
    name: group.name,
    models: group.models.map(model => {
      const route = { provider: group.id, model: model.id }
      return { key: routeKey(route), route, name: model.name }
    }),
  }))
  const offered = saved !== null && groups.some(group => group.models.some(model => sameRoute(model.route, saved)))
  const fallback = catalog?.default
  const defaultName = fallback === undefined ? undefined : find(catalog, fallback)?.name
  return {
    groups,
    ...saved !== null && !offered ? { unavailable: { key: routeKey(saved), route: saved, name: `${saved.provider}/${saved.model}` } } : {},
    ...fallback === undefined ? {} : { defaultModel: { route: { provider: fallback.provider, model: fallback.model }, name: defaultName ?? `${fallback.provider}/${fallback.model}` } },
  }
}

/** The efforts of `route`, or, without one, of dsh's default model, which an effort alone applies to; none for a model the catalog has not, or that has none. */
export function effortsOf(catalog: ModelCatalog | undefined, route: Route | null): Efforts {
  const target = route ?? catalog?.default ?? null
  const reasoning = target === null ? undefined : find(catalog, target)?.reasoning
  return { efforts: reasoning?.efforts ?? [], defaultEffort: reasoning?.defaultEffort }
}

function find(catalog: ModelCatalog | undefined, route: Route): ModelCatalog['groups'][number]['models'][number] | undefined {
  return catalog?.groups.find(group => group.id === route.provider)?.models.find(model => model.id === route.model)
}
