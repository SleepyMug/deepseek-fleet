import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { ServiceHandler } from '../box/world.ts'
import * as Relay from './relay.ts'

/** The relay, for a session whose agent links APIs whose implementations call `backends`, or with no spec. */
async function setup(backends: string[] | undefined) {
  const ctx = new Context()
  let handler: ServiceHandler | undefined
  const served: unknown[] = []
  ctx.provide('fleetBox', {
    serveCalls: (serve: ServiceHandler) => { handler = serve; return () => { handler = undefined } },
    rootHeaderOf: (id: string) => Promise.resolve({ id }),
  })
  const spec = backends === undefined ? undefined : { apis: [{ name: 'notes', backends }, { name: 'text-stats', backends: [] }] }
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

test('any other call is refused, as from a session with no spec', async () => {
  const linked = await setup(['notes'])
  await assert.rejects(linked.handler('session-a' as never, { service: 'archives', function: 'list', args: [] }, never), /links no API that calls the backend archives/u)
  await assert.rejects(linked.handler('session-a' as never, { service: 'constructor', function: 'name', args: [] }, never), /links no API/u)
  const web = await setup(undefined)
  await assert.rejects(web.handler('session-web' as never, { service: 'notes', function: 'addNote', args: [] }, never), /links no API/u)
  assert.deepEqual([...linked.served, ...web.served], [])
})
