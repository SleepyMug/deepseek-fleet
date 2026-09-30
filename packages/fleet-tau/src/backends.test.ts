import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { FleetBackends, method } from './backends.ts'

async function setup(): Promise<FleetBackends> {
  const ctx = new Context()
  await ctx.plugin(FleetBackends)
  let backends: FleetBackends | undefined
  await ctx.plugin({ name: 'caller', inject: ['fleetBackends'], apply: (inner: Context) => { backends = inner.fleetBackends } })
  assert.ok(backends !== undefined)
  return backends
}

const session = 'session-a' as SessionId
const never = new AbortController().signal

test('a backend\'s method runs only with arguments its schema accepts, for the calling session', async () => {
  const backends = await setup()
  const calls: unknown[] = []
  const dispose = backends.provide({
    name: 'notes',
    timeoutMs: 100,
    methods: {
      addNote: method(z.tuple([z.string(), z.array(z.string())]), ([text, tags], call) => { calls.push([text, tags, call.session]); return { id: 1, text } }),
      clear: method(z.tuple([]), () => undefined),
      wait: method(z.tuple([z.number()]), ([ms], { signal }) => new Promise((resolve) => { setTimeout(resolve, ms); signal.addEventListener('abort', () => { resolve(undefined) }) })),
    },
  })
  assert.deepEqual(backends.list(), ['notes'])
  assert.deepEqual(await backends.call(session, { service: 'notes', function: 'addNote', args: ['milk', ['shopping']] }, never), { id: 1, text: 'milk' })
  assert.deepEqual(calls, [['milk', ['shopping'], session]])
  // Nothing comes back as null.
  assert.equal(await backends.call(session, { service: 'notes', function: 'clear', args: [] }, never), null)
  await assert.rejects(backends.call(session, { service: 'notes', function: 'addNote', args: [42, []] }, never), /notes\.addNote: its arguments do not fit/u)
  await assert.rejects(backends.call(session, { service: 'notes', function: 'wait', args: [1000] }, never), /ran longer than 0\.1 s/u)
  await assert.rejects(backends.call(session, { service: 'notes', function: 'nope', args: [] }, never), /no method nope/u)
  await assert.rejects(backends.call(session, { service: 'notes', function: 'constructor', args: [] }, never), /no method constructor/u)
  dispose()
  await assert.rejects(backends.call(session, { service: 'notes', function: 'clear', args: [] }, never), /nothing provides the backend notes/u)
  assert.deepEqual(backends.list(), [])
})

test('a backend is provided once until it is removed', async () => {
  const backends = await setup()
  const dispose = backends.provide({ name: 'notes', methods: {} })
  assert.throws(() => backends.provide({ name: 'notes', methods: {} }), /provided already/u)
  dispose()
  backends.provide({ name: 'notes', methods: {} })
})
