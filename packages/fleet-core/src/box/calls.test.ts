import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MAX_CALL_BYTES } from 'fleet-image/helper/protocol'
import { ServiceCalls } from './calls.ts'

function setup() {
  const sent: Record<string, unknown>[] = []
  const calls = new ServiceCalls((line) => { sent.push(JSON.parse(line) as Record<string, unknown>) })
  return { calls, sent }
}

const call = (id: number, fields: Partial<{ service: string; function: string; args: unknown[] }> = {}) =>
  ({ call: id, service: 'notes', function: 'addNote', args: ['milk'], ...fields })

test('a call is served and answered once with its result', async () => {
  const { calls, sent } = setup()
  calls.serve(call => Promise.resolve({ echoed: call.args }))
  calls.receive(call(1), 100)
  await delay(0)
  assert.deepEqual(sent, [{ type: 'call-result', call: 1, result: { echoed: ['milk'] } }])
})

test('a failing call, and any call before something serves them, gets its reason back', async () => {
  const { calls, sent } = setup()
  calls.receive(call(1), 100)
  calls.serve(() => Promise.reject(new Error('disk full')))
  calls.receive(call(2), 100)
  await delay(0)
  assert.deepEqual(sent, [
    { type: 'call-error', call: 1, message: 'no services are provided here' },
    { type: 'call-error', call: 2, message: 'disk full' },
  ])
})

test('oversized calls and results, and bad names, are refused; any number of calls run at once', async () => {
  const { calls, sent } = setup()
  const held = Promise.withResolvers<unknown>()
  let waiting = 0
  calls.serve((request) => {
    if (request.function === 'huge') return Promise.resolve('x'.repeat(MAX_CALL_BYTES))
    waiting++
    return held.promise
  })
  calls.receive(call(1), MAX_CALL_BYTES + 1)
  calls.receive(call(2, { service: '../notes' }), 100)
  calls.receive(call(3, { function: 'f'.repeat(200) }), 100)
  calls.receive(call(4, { function: 'huge' }), 100)
  for (let id = 10; id < 74; id++) calls.receive(call(id), 100)
  await delay(0)
  assert.deepEqual(sent.map(message => [message.call, message.type]), [[1, 'call-error'], [2, 'call-error'], [3, 'call-error'], [4, 'call-error']])
  assert.match(String(sent[3]?.message), /result is over/u)
  assert.equal(waiting, 64)
})

test('a cancelled call, or one in flight when the connection ends, is not answered; a reused id in flight is ignored', async () => {
  const { calls, sent } = setup()
  const signals: AbortSignal[] = []
  calls.serve((_request, signal) => {
    signals.push(signal)
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }) })
  })
  calls.receive(call(1), 100)
  calls.receive(call(1), 100)
  calls.receive(call(2), 100)
  await delay(0)
  assert.equal(signals.length, 2)
  calls.cancel(1)
  calls.cancel(99)
  calls.abortAll(new Error('gone'))
  await delay(0)
  assert.ok(signals.every(signal => signal.aborted))
  assert.deepEqual(sent, [])
})
