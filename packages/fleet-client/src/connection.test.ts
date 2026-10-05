import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from 'fleet-protocol/tau'
import { ConnectionLost, NoService, ask, defaultSocket, request } from './connection.ts'

test('the socket is in the dsh home, as dsh finds it', () => {
  assert.equal(defaultSocket({}), join(homedir(), '.dsh', 'fleet', 'tau.sock'))
  assert.equal(defaultSocket({ DSH_HOME: ' ' }), join(homedir(), '.dsh', 'fleet', 'tau.sock'))
  assert.equal(defaultSocket({ DSH_HOME: '/srv/dsh' }), '/srv/dsh/fleet/tau.sock')
  assert.equal(defaultSocket({ DSH_HOME: '~/other' }), join(homedir(), 'other', 'fleet', 'tau.sock'))
})

test('a request goes as one line with the protocol version, and its answer comes back', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-client-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tau.sock')
  const received: string[] = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (line: string) => {
      received.push(line)
      socket.end('{"ok":true,"value":null}\n')
    })
  })
  await new Promise<void>((resolve) => { server.listen(path, resolve) })
  try {
    assert.deepEqual(await request(path, { op: 'cancel', sessionId: 'session-a' }), { ok: true, value: null })
    assert.deepEqual(received, [`{"protocol":${String(PROTOCOL_VERSION)},"op":"cancel","sessionId":"session-a"}\n`])
  } finally {
    await new Promise((resolve) => { server.close(resolve) })
  }
})

test('without a service, a request says how to start one', async () => {
  const refused = request('/nonexistent/tau.sock', { op: 'cancel', sessionId: 'session-a' })
  await assert.rejects(refused, NoService)
  await assert.rejects(refused, /no tau service at \/nonexistent\/tau\.sock; start the fleet host/u)
})

test('a service that goes away before it answers is a lost connection, and its error is ask\'s', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-client-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tau.sock')
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (line: string) => {
      if (line.includes('session-gone')) socket.destroy()
      else socket.end('{"ok":false,"error":"fleet: no tau session session-b"}\n')
    })
  })
  await new Promise<void>((resolve) => { server.listen(path, resolve) })
  try {
    await assert.rejects(request(path, { op: 'finish', sessionId: 'session-gone' }), ConnectionLost)
    await assert.rejects(ask(path, { op: 'finish', sessionId: 'session-b' }), /^Error: fleet: no tau session session-b$/u)
  } finally {
    await new Promise((resolve) => { server.close(resolve) })
  }
})
