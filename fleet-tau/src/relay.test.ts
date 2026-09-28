import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { ServiceHandler } from 'fleet-box/world'
import * as Relay from './relay.ts'

async function setup(services: Record<string, string[]> | undefined) {
  const ctx = new Context()
  let handler: ServiceHandler | undefined
  const served: unknown[] = []
  ctx.provide('fleetBox', {
    serveCalls: (serve: ServiceHandler) => { handler = serve; return () => { handler = undefined } },
    rootHeaderOf: (id: string) => Promise.resolve({ id }),
  })
  ctx.provide('fleetTau', { specOf: () => Promise.resolve(services === undefined ? undefined : { spec: { services }, owner: 'session-a' }) })
  ctx.provide('fleetServices', { call: (session: string, call: unknown) => { served.push([session, call]); return Promise.resolve('ok') } })
  await ctx.plugin(Relay)
  assert.ok(handler !== undefined)
  return { handler, served }
}

const never = new AbortController().signal

test('a call the session\'s agent declares is served for the container\'s own session', async () => {
  const { handler, served } = await setup({ notes: ['addNote'] })
  assert.equal(await handler('session-a' as never, { service: 'notes', function: 'addNote', args: ['x'] }, never), 'ok')
  assert.deepEqual(served, [['session-a', { service: 'notes', function: 'addNote', args: ['x'] }]])
})

test('any other call is refused, as from a session with no spec', async () => {
  const declared = await setup({ notes: ['addNote'] })
  await assert.rejects(declared.handler('session-a' as never, { service: 'notes', function: 'byTag', args: [] }, never), /does not declare notes\.byTag/u)
  await assert.rejects(declared.handler('session-a' as never, { service: 'constructor', function: 'name', args: [] }, never), /does not declare/u)
  const web = await setup(undefined)
  await assert.rejects(web.handler('session-web' as never, { service: 'notes', function: 'addNote', args: [] }, never), /does not declare/u)
  assert.deepEqual([...declared.served, ...web.served], [])
})
