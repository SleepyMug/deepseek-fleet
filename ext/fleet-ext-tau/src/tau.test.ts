import assert from 'node:assert/strict'
import { test } from 'node:test'
import { methods, type Service } from './tau.ts'

async function* once(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text)
}

/** A service that records what it is asked, as whom. */
function fake(calls: string[]): Service {
  return {
    start: async (caller, about, call) => {
      let text = ''
      for await (const chunk of call) text += Buffer.from(chunk).toString()
      calls.push(`start ${JSON.stringify(caller)} ${JSON.stringify(about)} ${text}`)
      return { sessionId: 'session-child', box: 'fleet-tau-child', prompt: 'Go.' }
    },
    finish: async (caller, sessionId) => {
      calls.push(`finish ${JSON.stringify(caller)} ${sessionId}`)
      return { result: { ok: true, text: 'Done.' }, targets: { '/out': '/tau/workspace/out.txt' }, archive: once('the result') }
    },
    cancel: async (caller, sessionId) => {
      calls.push(`cancel ${JSON.stringify(caller)} ${sessionId}`)
    },
  }
}

test('the server starts, finishes and cancels runs as the calling session\'s, with the call and the result after the JSON', async () => {
  const calls: string[] = []
  const server = methods(fake(calls))
  const call = { sessionId: 'session-parent', signal: new AbortController().signal }
  const about = { title: 'shout', targets: { '/out': '/tau/workspace/out.txt' } }
  assert.deepEqual(await server.start?.([about], { ...call, body: once('the call') }), { sessionId: 'session-child', box: 'fleet-tau-child', prompt: 'Go.' })
  const finished = await server.finish?.(['session-child'], call) as { value: unknown; body: AsyncIterable<Uint8Array> }
  assert.equal((finished as unknown as Record<symbol, unknown>)[Symbol.for('fleet.streamed')], true)
  assert.deepEqual(finished.value, { result: { ok: true, text: 'Done.' }, targets: { '/out': '/tau/workspace/out.txt' } })
  let body = ''
  for await (const chunk of finished.body) body += Buffer.from(chunk).toString()
  assert.equal(body, 'the result')
  assert.equal(await server.cancel?.(['session-child'], call), null)
  const parent = JSON.stringify({ kind: 'session', sessionId: 'session-parent' })
  assert.deepEqual(calls, [`start ${parent} ${JSON.stringify(about)} the call`, `finish ${parent} session-child`, `cancel ${parent} session-child`])
})

test('the server checks what the box sends', async () => {
  const server = methods(fake([]))
  const call = { sessionId: 'session-parent', signal: new AbortController().signal }
  const body = once('the call')
  await assert.rejects(async () => server.start?.([{ title: 'x', targets: {} }], call), /takes the run's call, after its arguments/u)
  await assert.rejects(async () => server.start?.(['x'], { ...call, body }), /takes \{ title, targets \}/u)
  await assert.rejects(async () => server.start?.([{ title: ' ', targets: {} }], { ...call, body }), /takes a title/u)
  await assert.rejects(async () => server.start?.([{ title: 'x', targets: { '/out': 'out.txt' } }], { ...call, body }), /each an absolute path in the box/u)
  await assert.rejects(async () => server.finish?.([7], call), /a run's id is a string/u)
})
