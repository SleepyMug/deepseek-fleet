import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fleetLoopback, fleetSocket, listenFleet } from '@sleepymug/tau/adaptors'
import type { RunStatus } from '@sleepymug/fleet-protocol/tau'
import { HOST, type Caller } from './registry.ts'
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
 * session named `session-fails`. A trace of `session-waits` waits until its
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
      return { state: 'ended', result: 1, ok: true }
    },
    result: async (caller, sessionId) => {
      await op('result')(caller, sessionId)
      return { value: { result: 1 }, body: once('the result') }
    },
    trace: async (caller, sessionId, signal) => {
      await op('trace')(caller, sessionId)
      if (sessionId === 'session-waits') {
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
        aborted.push(sessionId)
      }
      return { format: 'dsh-session-events', events: [{ type: 'turn/end' }] }
    },
    release: op('release'),
    contract: (name, range) => {
      calls.push(`contract ${name} ${String(range)}`)
      return { value: { name, version: '1.3.0', description: 'Notes.' }, body: once('the contract') }
    },
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
  assert.deepEqual(await service.exchange({ op: 'status', id: 'session-b' }), { value: { state: 'ended', result: 1, ok: true } })
  const result = await service.exchange({ op: 'result', id: 'session-a' })
  assert.deepEqual([result.value, await read(result.body)], [{ result: 1 }, 'the result'])
  assert.deepEqual(await service.exchange({ op: 'trace', id: 'session-a' }), { value: { format: 'dsh-session-events', events: [{ type: 'turn/end' }] } })
  assert.deepEqual(await service.exchange({ op: 'release', id: 'session-a' }), { value: null })
  assert.deepEqual(await service.exchange({ op: 'list' }), { value: [STATUS] })
  await assert.rejects(service.exchange({ op: 'release', id: 'session-fails' }), /^Error: fleet: no tau session session-fails$/u)
  const contract = await service.exchange({ op: 'contract', name: '@test/notes', range: '^1.2.0' })
  assert.deepEqual([contract.value, await read(contract.body)], [{ name: '@test/notes', version: '1.3.0', description: 'Notes.' }, 'the contract'])
  assert.deepEqual(calls, [
    `host submit t /c ${call}`, 'host status session-b', 'host result session-a', 'host trace session-a', 'host release session-a', 'host list', 'host release session-fails',
    'contract @test/notes ^1.2.0',
  ])

  // What does not fit is refused before the service sees it.
  await assert.rejects(service.exchange({ op: 'submit', title: ' ' }, once(call)), /^Error: submit takes a title, a string$/u)
  await assert.rejects(service.exchange({ op: 'submit', title: 't', project: 'c' }, once(call)), /takes project, an absolute path/u)
  await assert.rejects(service.exchange({ op: 'submit', title: 't', targets: {} }, once(call)), /^Error: submit takes no targets$/u)
  await assert.rejects(service.exchange({ op: 'result' }), /^Error: result takes the run's id, a string$/u)
  await assert.rejects(service.exchange({ op: 'status', id: 'session-a', since: 1 }), /^Error: status takes no since$/u)
  await assert.rejects(service.exchange({ op: 'finish', id: 'session-a' }), /^Error: fleet: no op finish$/u)
  await assert.rejects(service.exchange({ op: 'history', id: 'session-a' }), /^Error: fleet: no op history$/u)
  await assert.rejects(service.exchange({ op: 'contract', name: '@test/notes', range: '1.2.0' }), /^Error: contract takes range, \^ and a version/u)
  await assert.rejects(service.exchange({ op: 'cancel', id: 'session-a' }), /^Error: fleet: no op cancel$/u)
  assert.equal(calls.length, 8)
})

test('a session\'s requests are its own, as the way in names it', async () => {
  const calls: string[] = []
  const service = fleetLoopback(serveFor(fake(calls), { kind: 'session', sessionId: 'session-caller' }))
  assert.deepEqual(await service.exchange({ op: 'submit', title: 't' }, once('call')), { value: { id: 'session-new' } })
  await service.exchange({ op: 'list' })
  assert.deepEqual(calls, ['session-caller submit t undefined call', 'session-caller list'])
})

test('a client that goes away gives up what it asked for', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-wire-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tau.sock')
  const calls: string[] = []
  const aborted: string[] = []
  t.after(await listenFleet(path, serveFor(fake(calls, aborted), HOST)))
  const waiting = new AbortController()
  const tracing = fleetSocket(path).exchange({ op: 'trace', id: 'session-waits' }, undefined, waiting.signal)
  while (calls.length === 0) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(aborted, [])
  waiting.abort(new Error('enough'))
  await assert.rejects(tracing, /enough/u)
  while (aborted.length === 0) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(aborted, ['session-waits'])
})
