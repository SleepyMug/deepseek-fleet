import assert from 'node:assert/strict'
import { test } from 'node:test'
import { methods, type Service } from './tau.ts'

async function* once(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text)
}

async function read(bytes: AsyncIterable<Uint8Array>): Promise<string> {
  let text = ''
  for await (const chunk of bytes) text += Buffer.from(chunk).toString()
  return text
}

/** A service that records what it is asked, as whom, answering a result with bytes after it. */
function fake(calls: string[]): Service {
  return {
    handlerFor: caller => async (request, body) => {
      calls.push(`${JSON.stringify(caller)} ${JSON.stringify(request)} ${await read(body)}`)
      return request.op === 'result' ? { value: { result: 1 }, body: once('the result') } : { value: { id: 'session-child' } }
    },
  }
}

test('the server passes each request to the service as the calling session\'s, with the bytes after it, and after its answer', async () => {
  const calls: string[] = []
  const server = methods(fake(calls))
  const call = { sessionId: 'session-parent', signal: new AbortController().signal }
  assert.deepEqual(await server.exchange?.([{ op: 'submit', title: 'shout' }], { ...call, body: once('the call') }), { id: 'session-child' })
  const result = await server.exchange?.([{ op: 'result', id: 'session-child' }], call) as { value: unknown; body: AsyncIterable<Uint8Array> }
  assert.equal((result as unknown as Record<symbol, unknown>)[Symbol.for('fleet.streamed')], true)
  assert.deepEqual(result.value, { result: 1 })
  assert.equal(await read(result.body), 'the result')
  const parent = JSON.stringify({ kind: 'session', sessionId: 'session-parent' })
  assert.deepEqual(calls, [
    `${parent} {"op":"submit","title":"shout"} the call`,
    `${parent} {"op":"result","id":"session-child"} `,
  ])
})

test('the server takes a request, as an object with its op', async () => {
  const server = methods(fake([]))
  const call = { sessionId: 'session-parent', signal: new AbortController().signal }
  for (const request of [undefined, 'submit', [], { title: 'x' }, { op: 7 }]) {
    await assert.rejects(async () => server.exchange?.([request], call), /exchange takes a request, \{ op, … \}/u)
  }
})
