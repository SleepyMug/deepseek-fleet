import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import * as TauModelPlugin from './model.ts'
import { requestFor } from './model.ts'
import type { TauModel } from '../tau/model.ts'

/** dsh's default, as the session controller's listeners apply it. */
const DEFAULT: LlmCallConfig = { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: ReasoningEffortId('high'), maxTokens: 4096 }

test('a route takes the request, with its effort, or none, the route\'s own; an effort alone applies to dsh\'s default; nothing leaves it as it is', () => {
  assert.deepEqual(requestFor(DEFAULT, { route: { provider: 'mock', model: 'mock-model' }, reasoningEffort: 'low' }),
    { provider: 'mock', model: 'mock-model', reasoningEffort: 'low', maxTokens: 4096 })
  assert.deepEqual(requestFor(DEFAULT, { route: { provider: 'mock', model: 'mock-model' } }),
    { provider: 'mock', model: 'mock-model', maxTokens: 4096 })
  assert.deepEqual(requestFor(DEFAULT, { reasoningEffort: 'low' }), { ...DEFAULT, reasoningEffort: 'low' })
  assert.equal(requestFor(DEFAULT, {}), DEFAULT)
})

/** A session's agent: the header of its last request, none before the first, and the model picked in its chat box, if any. */
function agentOf(session: { header?: LlmCallConfig, picked?: LlmCallConfig } = {}): Agent {
  return { session: { requestHeader: () => session.header === undefined ? undefined : { config: session.header }, picked: session.picked } } as unknown as Agent
}

/** The model dsh's session controller gives an agent: the one picked, then its last request's, then dsh's default. */
function controllerModel(agent: Agent): LlmCallConfig {
  const session = agent.session as unknown as { requestHeader(): { config: LlmCallConfig } | undefined, picked?: LlmCallConfig }
  return session.picked ?? session.requestHeader()?.config ?? DEFAULT
}

/** A context with the session controller's listeners first, then the plugin, which reads `model.current`. */
async function withModel(model: { current: TauModel }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  ctx.systemPrompt.section({ name: 'persona', order: 0, text: 'You are powered by the {{model}} model.' })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const { provider, model } = controllerModel(context.agent!)
    return { ...assembly, variables: { ...assembly.variables, provider, model } }
  })
  ctx.on('agent/request', async ({ agent }, next) => ({ ...await next(), ...controllerModel(agent) }))
  ctx.provide('sessionProjections', {
    stateOf: (session: { picked?: LlmCallConfig }) => ({ pending: session.picked ?? null }),
  })
  ctx.provide('fleetTauModel', { current: () => model.current })
  await ctx.plugin(TauModelPlugin)
  return ctx
}

/** Assemble an agent's prompt, then make its request, as a step does. */
async function step(ctx: Context, agent: Agent): Promise<{ prompt: string, request: LlmCallConfig }> {
  const assembly = await ctx.systemPrompt.assemble({ agent } as unknown as AssembleContext)
  const prompt = renderPrompt(assembly)
  const request = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: '', model: '' }))
  return { prompt, request }
}

const TAU_MODEL: TauModel = { route: { provider: 'mock', model: 'mock-model' }, reasoningEffort: 'low' }

test('a tau\'s session starts on the configured model, in place of dsh\'s default, and its prompt names it', async () => {
  const ctx = await withModel({ current: TAU_MODEL })
  const { prompt, request } = await step(ctx, agentOf())
  assert.match(prompt, /^You are powered by the mock-model model\.$/mu)
  assert.deepEqual(request, { provider: 'mock', model: 'mock-model', reasoningEffort: 'low', maxTokens: 4096 })
})

test('after its first request, a session keeps the model dsh gives it, its last request\'s or one picked in its chat box', async () => {
  const ctx = await withModel({ current: TAU_MODEL })
  // Started on another model, before the setting changed: it stays there.
  const started = { provider: 'mock', model: 'other-model', reasoningEffort: ReasoningEffortId('high') }
  assert.deepEqual((await step(ctx, agentOf({ header: started }))).request, started)
  const picked = { provider: 'codex', model: 'gpt-6-astra' }
  const { prompt, request } = await step(ctx, agentOf({ header: started, picked }))
  assert.match(prompt, /^You are powered by the gpt-6-astra model\.$/mu)
  assert.equal(request.model, 'gpt-6-astra')
})

test('a model picked before the first request is the session\'s', async () => {
  const ctx = await withModel({ current: TAU_MODEL })
  assert.equal((await step(ctx, agentOf({ picked: { provider: 'codex', model: 'gpt-6-astra' } }))).request.model, 'gpt-6-astra')
})

test('without a route, the prompt and the request keep dsh\'s default', async () => {
  const ctx = await withModel({ current: {} })
  const { prompt, request } = await step(ctx, agentOf())
  assert.match(prompt, /^You are powered by the gpt-6-astra model\.$/mu)
  assert.deepEqual(request, DEFAULT)
})
