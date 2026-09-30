import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { HelperMessage } from './protocol.ts'
import { ServiceSocket } from './services.ts'

async function setup(options: { behind?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-box-services-'))
  const path = join(dir, 'run', 'services.sock')
  const sent: HelperMessage[] = []
  let drain: (() => void) | undefined
  let behind = options.behind ?? false
  const channel = {
    send: (message: HelperMessage) => {
      if (JSON.stringify(message).length > 4096) throw new Error('a call message does not fit in one line')
      sent.push(message)
      return !behind
    },
    onDrain: (listener: () => void) => { drain = listener },
  }
  const socket = new ServiceSocket(channel, path)
  await socket.listen()
  const catchUp = (): void => {
    behind = false
    drain?.()
  }
  return { socket, sent, path, catchUp, done: async () => { socket.close(); await rm(dir, { recursive: true, force: true }) } }
}

/** Make one call as a tau runtime does, and read the answer line, or what the socket closed with. */
function callOver(path: string, line: string, options: { closeAfterMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path)
    let answer = ''
    client.on('data', (chunk: Buffer) => { answer += chunk.toString('utf8') })
    client.on('close', () => { resolve(answer.trim()) })
    client.on('error', reject)
    client.write(line)
    if (options.closeAfterMs !== undefined) setTimeout(() => { client.destroy() }, options.closeAfterMs)
  })
}

test('a call is relayed to the host, and the host\'s answer goes back as one line', async () => {
  const { socket, sent, path, done } = await setup()
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const answered = callOver(path, '{"service":"notes","function":"addNote","args":["milk"]}\n')
    await delay(50)
    assert.deepEqual(sent, [{ type: 'call', call: 1, service: 'notes', function: 'addNote', args: ['milk'] }])
    socket.answer({ type: 'call-result', call: 1, result: { id: 1 } })
    assert.equal(await answered, '{"result":{"id":1}}')
    const failed = callOver(path, '{"service":"notes","function":"addNote","args":[]}\n')
    await delay(50)
    socket.answer({ type: 'call-error', call: 2, message: 'disk full' })
    assert.equal(await failed, '{"error":{"message":"disk full"}}')
  } finally {
    await done()
  }
})

test('a malformed or oversized call is refused in the container', async () => {
  const { sent, path, done } = await setup()
  try {
    assert.match(await callOver(path, 'not json\n'), /not a JSON line/u)
    assert.match(await callOver(path, '{"service":"notes","function":"f","args":{}}\n'), /args must be an array/u)
    assert.match(await callOver(path, `{"service":"notes","function":"f","args":["${'x'.repeat(5000)}"]}\n`), /does not fit/u)
    // The oversized one never reached the host: its message did not fit.
    assert.deepEqual(sent, [])
  } finally {
    await done()
  }
})

test('a program that goes away before its answer cancels the call', async () => {
  const { socket, sent, path, done } = await setup()
  try {
    await callOver(path, '{"service":"notes","function":"f","args":[]}\n', { closeAfterMs: 50 })
    await delay(50)
    assert.deepEqual(sent.map(message => message.type), ['call', 'call-cancel'])
    // A late answer goes nowhere.
    socket.answer({ type: 'call-result', call: 1, result: null })
  } finally {
    await done()
  }
})

test('while the host is behind, calls wait unread until it catches up', async () => {
  const { socket, sent, path, catchUp, done } = await setup({ behind: true })
  try {
    const first = callOver(path, '{"service":"s","function":"f","args":[1]}\n')
    await delay(50)
    const second = callOver(path, '{"service":"s","function":"f","args":[2]}\n')
    await delay(50)
    assert.equal(sent.length, 1)
    catchUp()
    await delay(50)
    assert.equal(sent.length, 2)
    socket.answer({ type: 'call-result', call: 1, result: 1 })
    socket.answer({ type: 'call-result', call: 2, result: 2 })
    assert.deepEqual([await first, await second], ['{"result":1}', '{"result":2}'])
  } finally {
    await done()
  }
})
