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

/** A context with dsh's default applied first, as the session controller does, then the plugin, which reads `model.current`. */
async function withModel(model: { current: TauModel }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  ctx.systemPrompt.section({ name: 'persona', order: 0, text: 'You are powered by the {{model}} model.' })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return { ...assembly, variables: { ...assembly.variables, provider: DEFAULT.provider, model: DEFAULT.model } }
  })
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), ...DEFAULT }))
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

test('a tau\'s session\'s prompt names the configured model, and its request goes to it, over dsh\'s default', async () => {
  const ctx = await withModel({ current: { route: { provider: 'mock', model: 'mock-model' }, reasoningEffort: 'low' } })
  const { prompt, request } = await step(ctx, {} as Agent)
  assert.match(prompt, /^You are powered by the mock-model model\.$/mu)
  assert.deepEqual(request, { provider: 'mock', model: 'mock-model', reasoningEffort: 'low', maxTokens: 4096 })
})

test('without a route, the prompt and the request keep dsh\'s default', async () => {
  const ctx = await withModel({ current: {} })
  const { prompt, request } = await step(ctx, {} as Agent)
  assert.match(prompt, /^You are powered by the gpt-6-astra model\.$/mu)
  assert.deepEqual(request, DEFAULT)
})

test('a request goes to the model its prompt was assembled with, and a change reaches the next step', async () => {
  const model = { current: { route: { provider: 'mock', model: 'first' } } as TauModel }
  const ctx = await withModel(model)
  const agent = {} as Agent
  await ctx.systemPrompt.assemble({ agent } as unknown as AssembleContext)
  model.current = { route: { provider: 'mock', model: 'second' } }
  const request = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: '', model: '' }))
  assert.equal(request.model, 'first')
  assert.equal((await step(ctx, agent)).request.model, 'second')
})
