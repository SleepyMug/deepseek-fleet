import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from 'fleet-protocol/tau'
import type { Caller } from './registry.ts'
import { listen, type Operations } from './server.ts'

/**
 * Send one line, and `body` after it, ending what is sent, and read the
 * answer, and what follows it, until the service ends the connection.
 */
function exchange(path: string, line: string, body?: string): Promise<{ answer: unknown; rest: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => {
      socket.write(`${line}\n`)
      if (body !== undefined) socket.end(body)
    })
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { received += chunk })
    socket.once('error', reject)
    socket.once('end', () => {
      const end = received.indexOf('\n')
      resolve({ answer: JSON.parse(received.slice(0, end)), rest: received.slice(end + 1) })
    })
  })
}

async function* once(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text)
}

const STATUS = { sessionId: 'session-a', title: 't', project: '/c', state: 'running', createdAt: 'now' } as const

/**
 * A service that records its calls, and fails a session named
 * `session-fails`. A finish of `session-waits` waits until its signal aborts,
 * which `aborted` then records.
 */
function fake(calls: string[], aborted: string[] = []): Operations {
  const op = (name: string) => (caller: Caller, sessionId: string): Promise<void> => {
    assert.equal(caller.kind, 'host')
    calls.push(`${name} ${sessionId}`)
    return sessionId === 'session-fails' ? Promise.reject(new Error(`fleet: no tau session ${sessionId}`)) : Promise.resolve()
  }
  return {
    start: async (caller, { title, project, targets }, call) => {
      assert.equal(caller.kind, 'host')
      const chunks: Uint8Array[] = []
      for await (const chunk of call) chunks.push(chunk)
      calls.push(`start ${title} ${String(project)} ${JSON.stringify(targets)} ${Buffer.concat(chunks).toString()}`)
      return { sessionId: 'session-new', box: 'fleet-tau-new', prompt: 'hi' }
    },
    list: (caller) => {
      assert.equal(caller.kind, 'host')
      calls.push('list')
      return Promise.resolve([STATUS])
    },
    status: async (caller, sessionId) => {
      await op('status')(caller, sessionId)
      return { ...STATUS, sessionId }
    },
    finish: async (caller, sessionId, signal, options) => {
      await op('finish')(caller, sessionId)
      if (sessionId === 'session-waits') {
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
        aborted.push(sessionId)
      }
      const history = options?.history === true ? { history: [{ type: 'turn/end' }] } : {}
      return { result: { ok: true, text: 'Done.' }, targets: { '/r': '/c/r' }, ...history, archive: once('the result') }
    },
    cancel: op('cancel'),
    delete: op('delete'),
  }
}

test('the socket answers each request with what the service did', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-server-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'fleet', 'tau.sock')
  const calls: string[] = []
  const close = await listen(path, fake(calls))
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const request = async (body: object, call?: string): Promise<unknown> => (await exchange(path, JSON.stringify({ protocol: PROTOCOL_VERSION, ...body }), call)).answer
    const start = { op: 'start', title: 't', project: '/c', targets: { '/r': '/c/r' } }

    // A start's call is all the client sends after its line.
    const call = 'a call, '.repeat(20000)
    assert.deepEqual(await request(start, call), { ok: true, value: { sessionId: 'session-new', box: 'fleet-tau-new', prompt: 'hi' } })
    assert.deepEqual(await request({ op: 'list' }), { ok: true, value: [STATUS] })
    assert.deepEqual(await request({ op: 'status', sessionId: 'session-b' }), { ok: true, value: { ...STATUS, sessionId: 'session-b' } })
    // A finish's result is all the service sends after its answer.
    assert.deepEqual(await exchange(path, JSON.stringify({ protocol: PROTOCOL_VERSION, op: 'finish', sessionId: 'session-a' })), {
      answer: { ok: true, value: { result: { ok: true, text: 'Done.' }, targets: { '/r': '/c/r' } } },
      rest: 'the result',
    })
    // And its session's history in its line, if asked for.
    assert.deepEqual(await exchange(path, JSON.stringify({ protocol: PROTOCOL_VERSION, op: 'finish', sessionId: 'session-a', history: true })), {
      answer: { ok: true, value: { result: { ok: true, text: 'Done.' }, targets: { '/r': '/c/r' }, history: [{ type: 'turn/end' }] } },
      rest: 'the result',
    })
    assert.deepEqual(await request({ op: 'cancel', sessionId: 'session-a' }), { ok: true, value: null })
    assert.deepEqual(await request({ op: 'delete', sessionId: 'session-fails' }), { ok: false, error: 'fleet: no tau session session-fails' })
    assert.deepEqual(calls, [`start t /c {"/r":"/c/r"} ${call}`, 'list', 'status session-b', 'finish session-a', 'finish session-a', 'cancel session-a', 'delete session-fails'])

    // A start refused is answered once the client has sent its call.
    assert.deepEqual(await request({ ...start, title: ' ' }, call), { ok: false, error: 'fleet: start takes a title' })
    assert.deepEqual(await request({ ...start, project: undefined }, call), { ok: false, error: 'fleet: start takes project, an absolute path' })
    assert.deepEqual(await request({ ...start, targets: { '/r': 'r' } }, call), { ok: false, error: 'fleet: start takes targets, each an absolute path' })
    assert.deepEqual(await request({ op: 'finish' }), { ok: false, error: 'fleet: finish takes a sessionId' })
    assert.deepEqual(await request({ op: 'finish', sessionId: 'session-a', history: 'yes' }), { ok: false, error: 'fleet: finish takes history, true or false' })
    assert.deepEqual(await request({ op: 'run' }), { ok: false, error: 'fleet: no op run' })
    assert.deepEqual((await exchange(path, JSON.stringify({ protocol: 0, op: 'list' }))).answer, {
      ok: false, error: `fleet: the client speaks protocol 0, and the tau service ${String(PROTOCOL_VERSION)}`,
    })
    assert.deepEqual((await exchange(path, '{')).answer, { ok: false, error: 'fleet: the request is not JSON' })
    assert.equal(calls.length, 7)
  } finally {
    await close()
  }
})

test('a client that goes away gives up its wait', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-server-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tau.sock')
  const calls: string[] = []
  const aborted: string[] = []
  const close = await listen(path, fake(calls, aborted))
  try {
    const socket = createConnection(path, () => { socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, op: 'finish', sessionId: 'session-waits' })}\n`) })
    while (calls.length === 0) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(aborted, [])
    socket.destroy()
    while (aborted.length === 0) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(aborted, ['session-waits'])
  } finally {
    await close()
  }
})

test('a socket a service answers on is not taken over, and one left behind is', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-server-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tau.sock')
  const close = await listen(path, fake([]))
  try {
    await assert.rejects(listen(path, fake([])), /another tau service serves/u)
  } finally {
    await close()
  }
  // What a service that died leaves.
  await writeFile(path, '')
  const again = await listen(path, fake([]))
  await again()
})
