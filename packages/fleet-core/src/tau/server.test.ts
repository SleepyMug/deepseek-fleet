import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from 'fleet-protocol/tau'
import type { Caller } from './registry.ts'
import { listen, type Operations } from './server.ts'

/** Send one line, and read the answer until the service ends the connection. */
function exchange(path: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => { socket.write(`${line}\n`) })
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { received += chunk })
    socket.once('error', reject)
    socket.once('end', () => { resolve(JSON.parse(received)) })
  })
}

const STATUS = { sessionId: 'session-a', tauDir: '/t', project: '/c', state: 'running', createdAt: 'now' } as const

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
    start: (caller, tauDir, values, callerCwd) => {
      assert.equal(caller.kind, 'host')
      calls.push(`start ${tauDir} ${JSON.stringify(values)} ${callerCwd}`)
      return Promise.resolve({ sessionId: 'session-new', box: 'fleet-tau-new', prompt: 'hi' })
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
    finish: async (caller, sessionId, signal) => {
      await op('finish')(caller, sessionId)
      if (sessionId === 'session-waits') {
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
        aborted.push(sessionId)
      }
      return { ok: true, text: 'Done.' }
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
    const request = (body: object): Promise<unknown> => exchange(path, JSON.stringify({ protocol: PROTOCOL_VERSION, ...body }))

    assert.deepEqual(await request({ op: 'start', tauDir: '/t', callerCwd: '/c', values: { a: 'b' } }), {
      ok: true, value: { sessionId: 'session-new', box: 'fleet-tau-new', prompt: 'hi' },
    })
    assert.deepEqual(await request({ op: 'list' }), { ok: true, value: [STATUS] })
    assert.deepEqual(await request({ op: 'status', sessionId: 'session-b' }), { ok: true, value: { ...STATUS, sessionId: 'session-b' } })
    assert.deepEqual(await request({ op: 'finish', sessionId: 'session-a' }), { ok: true, value: { ok: true, text: 'Done.' } })
    assert.deepEqual(await request({ op: 'cancel', sessionId: 'session-a' }), { ok: true, value: null })
    assert.deepEqual(await request({ op: 'delete', sessionId: 'session-fails' }), { ok: false, error: 'fleet: no tau session session-fails' })
    assert.deepEqual(calls, ['start /t {"a":"b"} /c', 'list', 'status session-b', 'finish session-a', 'cancel session-a', 'delete session-fails'])

    assert.deepEqual(await request({ op: 'start', tauDir: 't', callerCwd: '/c', values: {} }), { ok: false, error: 'fleet: start takes tauDir, an absolute path' })
    assert.deepEqual(await request({ op: 'finish' }), { ok: false, error: 'fleet: finish takes a sessionId' })
    assert.deepEqual(await request({ op: 'run' }), { ok: false, error: 'fleet: no op run' })
    assert.deepEqual(await exchange(path, JSON.stringify({ protocol: 0, op: 'list' })), {
      ok: false, error: `fleet: the client speaks protocol 0, and the tau service ${String(PROTOCOL_VERSION)}`,
    })
    assert.deepEqual(await exchange(path, '{'), { ok: false, error: 'fleet: the request is not JSON' })
    assert.equal(calls.length, 6)
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
