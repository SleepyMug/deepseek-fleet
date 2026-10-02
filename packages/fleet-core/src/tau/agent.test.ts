import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentPlugin from './agent.ts'
import { promptSpec } from './spec.ts'

function fakeAgent(id: string): Agent {
  return { id, session: { header: { id, cwd: '/w' } } } as unknown as Agent
}

async function setup(specOf: () => Promise<unknown>) {
  const ctx = new Context()
  const warnings: string[] = []
  const tools: string[] = []
  const sections: string[] = []
  ctx.provide('fleetTau', { specOf, configureFork: () => Promise.resolve() })
  ctx.provide('fleetBox', { ownerHeaderOf: () => Promise.reject(new Error('no lineage')) })
  ctx.provide('agents', { list: () => [] })
  ctx.provide('skills', { register: () => () => {} })
  ctx.provide('tools', { register: (tool: { name: string }) => { tools.push(tool.name); return () => {} } })
  ctx.provide('systemPrompt', { section: (section: { name: string }) => { sections.push(section.name); return () => {} }, getSectionOrder: () => 100 })
  ctx.provide('subprocess', {})
  ctx.logger.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  await ctx.plugin(AgentPlugin)
  return { ctx, warnings, tools, sections }
}

test('an agent whose spec cannot be read is created all the same, and the failure is logged', async () => {
  const { ctx, warnings } = await setup(() => Promise.reject(new Error('spec.json is not valid')))
  await ctx.serial('agent/created', { agent: fakeAgent('session-a'), source: 'startup' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /session-a goes on without its agent's customization: spec\.json is not valid/u)
})

test('an agent of a session not started from an agent directory gets the TypeScript tools, and is told how to run taus', async () => {
  for (const spec of [undefined, promptSpec('Fix the build.')]) {
    const { ctx, warnings, tools, sections } = await setup(() => Promise.resolve(spec === undefined ? undefined : { spec, owner: 'session-web' }))
    await ctx.serial('agent/created', { agent: fakeAgent('session-web'), source: 'startup' })
    assert.deepEqual(warnings, [])
    assert.deepEqual(tools, ['ts_modules', 'ts_execute'])
    assert.deepEqual(sections, ['fleet-tau:typescript', 'fleet-tau:taus'])
  }
})

test('an agent whose tau declares no tau API is not told how to run taus', async () => {
  const spec = { ...promptSpec('Count.'), agent: { name: 'count', source: '/a/count' }, apis: [{ name: 'text-stats', backends: [] }] }
  const { ctx, warnings, tools, sections } = await setup(() => Promise.resolve({ spec, owner: 'session-a' }))
  await ctx.serial('agent/created', { agent: fakeAgent('session-a'), source: 'startup' })
  assert.deepEqual(warnings, [])
  assert.deepEqual(tools, ['ts_modules', 'ts_execute'])
  assert.deepEqual(sections, ['fleet-tau:typescript'])
})

test('a subagent whose root cannot be found is left alone', async () => {
  const { ctx, warnings } = await setup(() => Promise.resolve(undefined))
  const agent = { id: 'sub', session: { header: { id: 'sub', origin: 'subagent', parentSession: 'gone' } } } as unknown as Agent
  await ctx.serial('agent/created', { agent, source: 'resume' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /no lineage/u)
})
