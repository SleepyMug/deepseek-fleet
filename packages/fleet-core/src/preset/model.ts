/**
 * fleet-tau-preset-model, as a dsh plugin that fleet-core's `tau` agent
 * preset mounts: a tau's session starts on the model fleet-tau-model's
 * config names (../tau/model-plugin.ts), in place of dsh's default, as
 * every other session starts on dsh's default. dsh's session controller
 * gives a session's request its own model, from the model picked in its
 * chat box, then the model of its last request, which its log keeps, then
 * dsh's default; this plugin takes the default's place alone, before the
 * session's first request, with no model picked yet, and leaves the rest to
 * the controller, so a person switches a tau's session's model as any
 * other's. Its listeners are prepended, so they wrap the controller's,
 * which were registered first, as the agent was set up, before the preset
 * was mounted: the first request goes to the model, and the system prompt
 * names it, as the persona's `{{model}}`.
 * @module @sleepymug/fleet-core/preset/model
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '../services.ts'
import type { TauModel, TauModelChoice } from '../tau/model.ts'

export const name = 'fleet-tau-preset-model'
export const inject = ['fleetTauModel', 'sessionProjections']

/** The request's config as `model` has it: its route and effort for a route, its effort alone otherwise. */
export function requestFor(config: LlmCallConfig, model: TauModel): LlmCallConfig {
  const { route, reasoningEffort } = model
  if (route === undefined) return reasoningEffort === undefined ? config : { ...config, reasoningEffort: ReasoningEffortId(reasoningEffort) }
  // dsh's default's effort is none of this route's.
  const { reasoningEffort: _default, ...rest } = config
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
  }
}

export function apply(ctx: Context): void {
  const choice: TauModelChoice = ctx.fleetTauModel
  // Where the controller would give dsh's default: no request made yet, and no model picked in the session.
  const starts = (agent: Agent): boolean => agent.session.requestHeader() === undefined
    && (ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending ?? null) === null
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || !starts(agent)) return assembly
    const { route } = choice.current()
    if (route === undefined) return assembly
    return { ...assembly, variables: { ...assembly.variables, provider: route.provider, model: route.model } }
  }, { prepend: true })
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    return starts(agent) ? requestFor(config, choice.current()) : config
  }, { prepend: true })
}
