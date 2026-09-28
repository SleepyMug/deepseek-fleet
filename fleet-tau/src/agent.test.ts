import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentPlugin from './agent.ts'

function fakeAgent(id: string): Agent {
  return { id, session: { header: { id, cwd: '/w' } } } as unknown as Agent
}

async function setup(specOf: () => Promise<unknown>) {
  const ctx = new Context()
  const warnings: string[] = []
  ctx.provide('fleetTau', { specOf, configureFork: () => Promise.resolve() })
  ctx.provide('fleetBox', { rootHeaderOf: () => Promise.reject(new Error('no lineage')) })
  ctx.provide('agents', { list: () => [] })
  ctx.provide('skills', { register: () => () => {} })
  ctx.logger.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  await ctx.plugin(AgentPlugin)
  return { ctx, warnings }
}

test('an agent whose spec cannot be read is created all the same, and the failure is logged', async () => {
  const { ctx, warnings } = await setup(() => Promise.reject(new Error('spec.json is not valid')))
  await ctx.serial('agent/created', { agent: fakeAgent('session-a'), source: 'startup' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /session-a goes on without its agent's customization: spec\.json is not valid/u)
})

test('an agent of a session without a spec, or with nothing to give, gets nothing', async () => {
  const { ctx, warnings } = await setup(() => Promise.resolve(undefined))
  await ctx.serial('agent/created', { agent: fakeAgent('session-web'), source: 'startup' })
  assert.deepEqual(warnings, [])
})

test('a subagent whose root cannot be found is left alone', async () => {
  const { ctx, warnings } = await setup(() => Promise.resolve(undefined))
  const agent = { id: 'sub', session: { header: { id: 'sub', origin: 'subagent', parentSession: 'gone' } } } as unknown as Agent
  await ctx.serial('agent/created', { agent, source: 'resume' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /no lineage/u)
})
