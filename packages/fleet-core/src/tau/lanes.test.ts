import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LanesPlugin from './lanes-plugin.ts'
import { Lanes } from './lanes.ts'

/** Let what is settled run on. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Whether a promise has settled yet. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => { done = true }, () => { done = true })
  await settle()
  return done
}

test('no more calls hold a lane than there are lanes, and the others have one as lanes are given back, first come, first served', async () => {
  const lanes = new Lanes(() => 2)
  const first = await lanes.take()
  const second = await lanes.take()
  const order: string[] = []
  const third = lanes.take().then((release) => { order.push('third'); return release })
  const fourth = lanes.take().then((release) => { order.push('fourth'); return release })
  assert.equal(await settled(third), false)
  assert.deepEqual(lanes.load, { busy: 2, waiting: 2 })
  first?.()
  // Given back twice, a lane is given back once.
  first?.()
  assert.equal(await settled(fourth), false)
  second?.()
  await Promise.all([third, fourth])
  assert.deepEqual(order, ['third', 'fourth'])
  assert.deepEqual(lanes.load, { busy: 2, waiting: 0 })
})

test('a wait given up has no lane, and leaves the others waiting as they were', async () => {
  const lanes = new Lanes(() => 1)
  const held = await lanes.take()
  const giving = new AbortController()
  const given = lanes.take(giving.signal)
  const next = lanes.take()
  giving.abort()
  assert.equal(await given, undefined)
  assert.deepEqual(lanes.load, { busy: 1, waiting: 1 })
  held?.()
  assert.equal(typeof await next, 'function')
  assert.equal(await lanes.take(AbortSignal.abort()), undefined)
})

test('the number of lanes is read as each is taken and given back, and the calls are counted while there is no cap', async () => {
  let capacity: number | undefined
  const lanes = new Lanes(() => capacity)
  const held = await Promise.all([lanes.take(), lanes.take()])
  capacity = 2
  const waiting = lanes.take()
  assert.equal(await settled(waiting), false)
  capacity = 3
  held[0]?.()
  // Given back, the lane and the one more there is now go to the call that waits.
  await waiting
  assert.deepEqual(lanes.load, { busy: 2, waiting: 0 })
})

/** A model call's stream that ends as the test says, and records that it began. */
function call(began: string[], label: string): { next: () => AsyncIterable<StreamChunk>, end: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>()
  return {
    next: () => (async function* () {
      began.push(label)
      await promise
      yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
    })(),
    end: resolve,
  }
}

/** Read a stream to its end. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _ of stream) { /* each chunk */ }
}

test('a tau\'s session\'s calls take lanes of one pool, whatever their provider, and every other call goes as it is', async () => {
  const ctx = new Context()
  ctx.provide('fleetTauRuns', { isTau: (sessionId: string) => sessionId.startsWith('tau-') })
  await ctx.plugin(LanesPlugin, { lanes: 1 })
  const began: string[] = []
  const stream = (sessionId: string | undefined, provider: string, made: { next: () => AsyncIterable<StreamChunk> }, signal?: AbortSignal): Promise<void> => {
    const options = { provider, model: 'm', messages: [], ...sessionId === undefined ? {} : { sessionId }, ...signal === undefined ? {} : { signal } } as unknown as GenerateOptions
    return drain(ctx.waterfall('llm/stream', options, made.next))
  }
  const a = call(began, 'tau-a')
  const b = call(began, 'tau-b')
  const person = call(began, 'person')
  const none = call(began, 'none')
  const streams = [stream('tau-a', 'one', a), stream('tau-b', 'two', b), stream('session-x', 'one', person), stream(undefined, 'one', none)]
  await settle()
  assert.deepEqual([...began].sort(), ['none', 'person', 'tau-a'])
  person.end()
  none.end()
  a.end()
  await settle()
  assert.deepEqual(began.slice(-1), ['tau-b'])
  b.end()
  await Promise.all(streams)

  // A call whose wait is given up goes on to its provider, its signal aborted, without a lane.
  const c = call(began, 'tau-c')
  const d = call(began, 'tau-d')
  const giving = new AbortController()
  const held = stream('tau-c', 'one', c)
  const given = stream('tau-d', 'one', d, giving.signal)
  await settle()
  assert.deepEqual(began.slice(-1), ['tau-c'])
  giving.abort()
  await settle()
  assert.deepEqual(began.slice(-2), ['tau-c', 'tau-d'])
  d.end()
  c.end()
  await Promise.all([held, given])
})
