import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fleetLoopback, fleetSocket, listenFleet } from '@sleepymug/tau/adaptors'
import type { RunStatus } from '@sleepymug/fleet-protocol/tau'
import type { Caller } from './registry.ts'
import { HOST } from './runs.ts'
import { serveFor, type Operations } from './wire.ts'

async function* once(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text)
}

async function read(bytes: AsyncIterable<Uint8Array> | undefined): Promise<string> {
  let text = ''
  for await (const chunk of bytes ?? []) text += Buffer.from(chunk).toString('utf8')
  return text
}

const STATUS: RunStatus = { sessionId: 'session-a', title: 't', project: '/c', prompt: 'hi', state: 'running', createdAt: 'now' }

/**
 * A service that records its calls, each with who made it, and fails a
 * session named `session-fails`. A finish of `session-waits` waits until its
 * signal aborts, which `aborted` then records.
 */
function fake(calls: string[], aborted: string[] = []): Operations {
  const who = (caller: Caller): string => caller.kind === 'host' ? 'host' : caller.sessionId
  const op = (name: string) => async (caller: Caller, sessionId: string): Promise<void> => {
    calls.push(`${who(caller)} ${name} ${sessionId}`)
    if (sessionId === 'session-fails') throw new Error(`fleet: no tau session ${sessionId}`)
  }
  return {
    submit: async (caller, { title, project }, call) => {
      calls.push(`${who(caller)} submit ${title} ${String(project)} ${await read(call)}`)
      return { sessionId: 'session-new', box: 'fleet-tau-new', prompt: 'hi' }
    },
    list: async (caller) => {
      calls.push(`${who(caller)} list`)
      return [STATUS]
    },
    status: async (caller, sessionId) => {
      await op('status')(caller, sessionId)
      return { ...STATUS, sessionId }
    },
    history: async (caller, sessionId) => {
      await op('history')(caller, sessionId)
      return [{ type: 'turn/end' }]
    },
    finish: async (caller, sessionId, signal) => {
      await op('finish')(caller, sessionId)
      if (sessionId === 'session-waits') {
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
        aborted.push(sessionId)
      }
      return once('the result')
    },
    release: op('release'),
  }
}

test('the socket serves the host the requests of a run, and the service\'s own', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-wire-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'fleet', 'tau.sock')
  const calls: string[] = []
  const close = await listenFleet(path, serveFor(fake(calls), HOST))
  t.after(close)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const service = fleetSocket(path)

  const call = 'a call, '.repeat(20000)
  assert.deepEqual(await service.exchange({ op: 'submit', title: 't', project: '/c' }, once(call)), { value: { id: 'session-new' } })
  const finished = await service.exchange({ op: 'finish', id: 'session-a' })
  assert.deepEqual([finished.value, await read(finished.body)], [null, 'the result'])
  assert.deepEqual(await service.exchange({ op: 'release', id: 'session-a' }), { value: null })
  assert.deepEqual(await service.exchange({ op: 'list' }), { value: [STATUS] })
  assert.deepEqual(await service.exchange({ op: 'status', id: 'session-b' }), { value: { ...STATUS, sessionId: 'session-b' } })
  assert.deepEqual(await service.exchange({ op: 'history', id: 'session-a' }), { value: [{ type: 'turn/end' }] })
  await assert.rejects(service.exchange({ op: 'release', id: 'session-fails' }), /^Error: fleet: no tau session session-fails$/u)
  assert.deepEqual(calls, [
    `host submit t /c ${call}`, 'host finish session-a', 'host release session-a', 'host list', 'host status session-b', 'host history session-a', 'host release session-fails',
  ])

  // What does not fit is refused before the service sees it.
  await assert.rejects(service.exchange({ op: 'submit', title: ' ' }, once(call)), /^Error: submit takes a title, a string$/u)
  await assert.rejects(service.exchange({ op: 'submit', title: 't', project: 'c' }, once(call)), /takes project, an absolute path/u)
  await assert.rejects(service.exchange({ op: 'submit', title: 't', targets: {} }, once(call)), /^Error: submit takes no targets$/u)
  await assert.rejects(service.exchange({ op: 'finish' }), /^Error: finish takes the run's id, a string$/u)
  await assert.rejects(service.exchange({ op: 'status' }), /^Error: fleet: status takes the run's id, a string$/u)
  await assert.rejects(service.exchange({ op: 'cancel', id: 'session-a' }), /^Error: fleet: no op cancel$/u)
  assert.equal(calls.length, 7)
})

test('a session\'s requests are its own, as the way in names it', async () => {
  const calls: string[] = []
  const service = fleetLoopback(serveFor(fake(calls), { kind: 'session', sessionId: 'session-caller' }))
  assert.deepEqual(await service.exchange({ op: 'submit', title: 't' }, once('call')), { value: { id: 'session-new' } })
  await service.exchange({ op: 'list' })
  assert.deepEqual(calls, ['session-caller submit t undefined call', 'session-caller list'])
})

test('a client that goes away gives up its wait', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-wire-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tau.sock')
  const calls: string[] = []
  const aborted: string[] = []
  t.after(await listenFleet(path, serveFor(fake(calls, aborted), HOST)))
  const waiting = new AbortController()
  const finishing = fleetSocket(path).exchange({ op: 'finish', id: 'session-waits' }, undefined, waiting.signal)
  while (calls.length === 0) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(aborted, [])
  waiting.abort(new Error('enough'))
  await assert.rejects(finishing, /enough/u)
  while (aborted.length === 0) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(aborted, ['session-waits'])
})
