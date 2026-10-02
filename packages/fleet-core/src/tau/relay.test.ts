import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { ServiceHandler } from '../box/world.ts'
import * as Relay from './relay.ts'

/** The relay, for a session whose agent links APIs whose implementations call `backends`, or a prompt run's, or with no spec. */
async function setup(backends: string[] | undefined, fromAgent = true) {
  const ctx = new Context()
  let handler: ServiceHandler | undefined
  const served: [string, unknown][] = []
  ctx.provide('fleetBox', {
    serveCalls: (serve: ServiceHandler) => { handler = serve; return () => { handler = undefined } },
    ownerHeaderOf: (id: string) => Promise.resolve({ id }),
  })
  const agent = fromAgent ? { agent: { name: 'notes', source: '/a/notes' } } : {}
  const spec = backends === undefined ? undefined : { ...agent, apis: [{ name: 'notes', backends }, { name: 'text-stats', backends: [] }] }
  ctx.provide('fleetTau', { specOf: () => Promise.resolve(spec === undefined ? undefined : { spec, owner: 'session-a' }) })
  ctx.provide('fleetBackends', { call: (session: string, call: unknown) => { served.push([session, call]); return Promise.resolve('ok') } })
  await ctx.plugin(Relay)
  assert.ok(handler !== undefined)
  return { handler, served }
}

const never = new AbortController().signal

test('a call to a backend an API of the session\'s agent calls is served for the container\'s own session', async () => {
  const { handler, served } = await setup(['notes'])
  assert.equal(await handler('session-a' as never, { service: 'notes', function: 'addNote', args: ['x'] }, never), 'ok')
  assert.deepEqual(served, [['session-a', { service: 'notes', function: 'addNote', args: ['x'] }]])
})

test('a session not started from an agent directory calls the tau backend, as one whose agent declares the tau API would', async () => {
  const web = await setup(undefined)
  assert.equal(await web.handler('session-web' as never, { service: 'tau', function: 'run', args: [] }, never), 'ok')
  // A prompt run has a spec, without an agent, and so without APIs of its own.
  const prompt = await setup([], false)
  assert.equal(await prompt.handler('session-p' as never, { service: 'tau', function: 'run', args: [] }, never), 'ok')
  assert.deepEqual([...web.served, ...prompt.served].map(([session]) => session), ['session-web', 'session-p'])
})

test('any other call is refused', async () => {
  const linked = await setup(['notes'])
  await assert.rejects(linked.handler('session-a' as never, { service: 'archives', function: 'list', args: [] }, never), /has no API that calls the backend archives/u)
  await assert.rejects(linked.handler('session-a' as never, { service: 'constructor', function: 'name', args: [] }, never), /has no API/u)
  // An agent that does not declare the tau API runs no taus.
  await assert.rejects(linked.handler('session-a' as never, { service: 'tau', function: 'run', args: [] }, never), /has no API that calls the backend tau/u)
  const web = await setup(undefined)
  await assert.rejects(web.handler('session-web' as never, { service: 'notes', function: 'addNote', args: [] }, never), /has no API/u)
  assert.deepEqual([...linked.served, ...web.served], [])
})
