/**
 * fleet-tau-preset-model, as a dsh plugin that fleet-core's `tau` agent
 * preset mounts: each request of a tau's session goes to the model
 * fleet-tau-model's config names (../tau/model-plugin.ts), as
 * `ctx.fleetTauModel` has it then, and its system prompt names that model,
 * as the persona's `{{model}}`. A route
 * left unset follows dsh's default, which a person picks in the web UI, as
 * dsh's session controller gives each session; an effort left unset is the
 * route's own. Its listeners are prepended, so they wrap the session
 * controller's, which apply dsh's default and were registered first, as the
 * agent was set up, before the preset was mounted. The request header the
 * session's log keeps is what they make, which the controller then follows,
 * so it tells the model of no switch.
 * @module @sleepymug/fleet-core/preset/model
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '../services.ts'
import type { TauModel, TauModelChoice } from '../tau/model.ts'

export const name = 'fleet-tau-preset-model'
export const inject = ['fleetTauModel']

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
  // The model as each agent's prompt was assembled with it, so its request goes where its prompt said, as a change between them waits for the next step.
  const assembled = new WeakMap<Agent, TauModel>()
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const model = choice.current()
    if (agent !== undefined) assembled.set(agent, model)
    if (model.route === undefined) return assembly
    return { ...assembly, variables: { ...assembly.variables, provider: model.route.provider, model: model.route.model } }
  }, { prepend: true })
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    return requestFor(config, assembled.get(agent) ?? choice.current())
  }, { prepend: true })
}
