import assert from 'node:assert/strict'
import { existsSync, readlinkSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants, createServer as createChannel, type ServerHttp2Stream } from 'node:http2'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { NO_SERVICE, OPENED, serviceOf } from '@sleepymug/fleet-protocol/channel'
import { SERVICES_VARIABLE } from '@sleepymug/fleet-protocol/layout'
import type { HelperMessage, GatewayMessage, ServiceInBox } from '@sleepymug/fleet-protocol/helper'
import type { ServicesLayout } from './cmd/services.ts'
import { serve } from './serve.ts'

/** A request's answer, with the events before it. */
type Answer = Extract<HelperMessage, { id: number }> & { value?: unknown; events: unknown[] }

/** A helper served in this process, as the gateway talks to it: requests answered by id, and what else it sends, kept. */
class Served {
  readonly input = new PassThrough()
  readonly output = new PassThrough()
  /** What the helper sent that answers no request. */
  readonly sent: HelperMessage[] = []
  readonly logged: string[] = []
  readonly done: Promise<void>
  private readonly waiting = new Map<number, { events: unknown[]; resolve: (message: Answer) => void }>()
  private readonly watchers = new Set<() => void>()
  private nextId = 1

  constructor(env: Record<string, string | undefined>, cwd: string, layout: ServicesLayout) {
    let text = ''
    this.output.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n')) {
        const message = JSON.parse(text.slice(0, end)) as HelperMessage
        text = text.slice(end + 1)
        this.take(message)
      }
    })
    this.done = serve({ input: this.input, output: this.output, env, cwd, log: message => this.logged.push(message), layout })
  }

  async request(method: string, params: unknown): Promise<Answer> {
    const id = this.nextId++
    const answered = new Promise<Answer>((resolve) => { this.waiting.set(id, { events: [], resolve }) })
    this.write({ type: 'request', id, method, params })
    return await answered
  }

  write(message: GatewayMessage | string): void {
    this.input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
  }

  /** Once the helper has sent what `found` finds. */
  async until<T>(found: () => T | undefined): Promise<T> {
    for (;;) {
      const value = found()
      if (value !== undefined) return value
      await new Promise<void>((resolve) => { this.watchers.add(resolve) })
    }
  }

  async close(): Promise<void> {
    this.input.end()
    await this.done
  }

  private take(message: HelperMessage): void {
    const id = 'id' in message ? message.id : undefined
    const waiting = id === undefined ? undefined : this.waiting.get(id)
    if (waiting !== undefined && message.type === 'event') waiting.events.push(message.value)
    else if (waiting !== undefined && id !== undefined) {
      this.waiting.delete(id)
      waiting.resolve({ ...message, events: waiting.events } as Answer)
    } else this.sent.push(message)
    for (const wake of this.watchers) wake()
    this.watchers.clear()
  }
}

/** A fresh folder of the test's, with the services' layout in it. */
async function scratch(t: { after: (fn: () => Promise<void>) => void }): Promise<{ work: string; layout: ServicesLayout }> {
  const work = await mkdtemp(join(tmpdir(), 'fleet-serve-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  return { work, layout: { services: join(work, 'services'), bin: join(work, 'bin'), sockets: join(work, 'sockets'), channel: join(work, 'channel.sock') } }
}

/** The gateway's end of the box's channel, as a test has it: each stream taken by `take`, by its service, or refused. */
async function gatewayChannel(t: { after: (fn: () => Promise<void>) => void }, path: string, take: (service: string, stream: ServerHttp2Stream) => boolean): Promise<void> {
  const server = createChannel()
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    const service = serviceOf(headers[':path'])
    if (service === undefined || !take(service, stream)) {
      stream.respond({ ':status': NO_SERVICE }, { endStream: true })
      return
    }
    stream.respond({ ':status': OPENED })
  })
  await new Promise<void>((resolve) => { server.listen(path, resolve) })
  t.after(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
}

/** What a stream sent, up to its end. */
async function received(stream: ServerHttp2Stream): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += (chunk as Buffer).toString('utf8')
  return text
}

/** The text of a spawn's stdout events. */
function stdout(answer: { events: unknown[] }): string {
  return answer.events.map(event => Buffer.from((event as { data: string }).data, 'base64').toString('utf8')).join('')
}

test('a helper serves in the environment and folder it is given, its services\' sockets and commands named there, not in its process\'s', async (t) => {
  const { work, layout } = await scratch(t)
  await writeFile(join(work, 'here.txt'), 'here\n')
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, ONLY_HERE: 'yes' }
  const before = process.env[SERVICES_VARIABLE]
  const helper = new Served(env, work, layout)
  assert.deepEqual(await helper.request('echo', { text: 'hi' }), { type: 'result', id: 1, value: { text: 'hi' }, events: [] })
  assert.deepEqual((await helper.request('fs.resolve', { path: 'here.txt' })).type === 'result', true)
  const spawned = await helper.request('spawn', {
    process: 'p', argv: ['sh', '-c', 'printf "%s %s %s" "$ONLY_HERE" "$FLEET_SERVICES" "${PATH%%:*}"'], cwd: work, env: { PATH: '/usr/bin:/bin' }, stdin: null, graceMs: 1000,
  })
  assert.equal(stdout(spawned), `yes ${layout.sockets} ${layout.bin}`)
  helper.write('not json')
  await helper.close()
  assert.equal(process.env[SERVICES_VARIABLE], before)
  assert.deepEqual(helper.logged, ['unreadable message'])
})

test('a service the box holds is synced in: its commands on the PATH, its environment, and its socket, whose connections are relayed both ways, each end a half-close', async (t) => {
  const { work, layout } = await scratch(t)
  const helper = new Served({ PATH: process.env.PATH }, work, layout)
  t.after(() => helper.close())
  // As the gateway copies a service's package in.
  const pkg = join(layout.services, 'notes@0123456789abcdef')
  await mkdir(join(pkg, 'bin'), { recursive: true })
  await writeFile(join(pkg, 'bin', 'notes.mjs'), '#!/usr/bin/env node\nconsole.log(`notes at ${process.env.NOTES_AT}`)\n')
  await chmod(join(pkg, 'bin', 'notes.mjs'), 0o644)
  assert.deepEqual((await helper.request('services.installed', {})).value, { notes: ['0123456789abcdef'] })
  const notes: ServiceInBox = { name: 'notes', digest: '0123456789abcdef', bins: { notes: 'bin/notes.mjs' }, env: { NOTES_AT: 'the socket' } }
  assert.equal((await helper.request('services.sync', { services: [notes] })).type, 'result')
  assert.equal(readlinkSync(join(layout.services, 'notes')), 'notes@0123456789abcdef')
  const ran = await helper.request('spawn', { process: 'n', argv: ['sh', '-c', 'notes'], cwd: work, env: {}, stdin: null, graceMs: 1000 })
  assert.equal(stdout(ran), 'notes at the socket\n')
  assert.deepEqual((await helper.request('which', { command: 'notes', env: { PATH: '/bin' } })).value, join(layout.bin, 'notes'))

  // A program in the box opens the service's socket; the gateway answers for the service, on the box's channel.
  const streams: Array<{ service: string; stream: ServerHttp2Stream }> = []
  await gatewayChannel(t, layout.channel, (service, stream) => {
    streams.push({ service, stream })
    return true
  })
  const socket = createConnection(join(layout.sockets, 'notes.sock'))
  let answer = ''
  socket.on('data', (chunk: Buffer) => { answer += chunk.toString('utf8') })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  // More than the stream's window, so that each side reads as the other writes.
  const big = 'm'.repeat(3 * 1024 * 1024)
  socket.write(`add ${big}\n`)
  socket.end()
  const { service, stream } = await until(() => streams[0])
  assert.equal(service, 'notes')
  // The program's end is the request's, a half-close: the gateway answers after it.
  assert.equal(await received(stream), `add ${big}\n`)
  stream.end('added\n')
  await closed
  assert.equal(answer, 'added\n')
  assert.equal(stream.rstCode, constants.NGHTTP2_NO_ERROR, 'a connection ended by both sides is not cut')

  // Synced without it, the box has none of it but its package.
  assert.equal((await helper.request('services.sync', { services: [] })).type, 'result')
  assert.equal(existsSync(join(layout.bin, 'notes')), false)
  assert.equal(existsSync(join(layout.services, 'notes')), false)
  assert.equal(existsSync(pkg), true)
  const gone = await helper.request('spawn', { process: 'm', argv: ['sh', '-c', 'printf "%s" "${NOTES_AT-unset}"'], cwd: work, env: {}, stdin: null, graceMs: 1000 })
  assert.equal(stdout(gone), 'unset')
  assert.equal((await helper.request('services.sync', { services: [{ ...notes, digest: 'fedcba9876543210' }] })).type, 'error')
})

test('a connection the box\'s side closes is ended on the gateway\'s, and one the gateway cuts, or refuses, is cut in the box', async (t) => {
  const { work, layout } = await scratch(t)
  const helper = new Served({ PATH: process.env.PATH }, work, layout)
  t.after(() => helper.close())
  await mkdir(join(layout.services, 'echo@aaaaaaaa'), { recursive: true })
  await mkdir(join(layout.services, 'gone@bbbbbbbb'), { recursive: true })
  await helper.request('services.sync', { services: [{ name: 'echo', digest: 'aaaaaaaa', bins: {}, env: {} }, { name: 'gone', digest: 'bbbbbbbb', bins: {}, env: {} }] })
  const streams: ServerHttp2Stream[] = []
  await gatewayChannel(t, layout.channel, (service, stream) => {
    if (service !== 'echo') return false
    streams.push(stream)
    return true
  })
  const first = createConnection(join(layout.sockets, 'echo.sock'))
  first.write('hi')
  const opened = await until(() => streams[0])
  // A closed socket's end is all its other side sees of it, as a request's end, after which the service answers no one.
  first.destroy()
  assert.equal(await received(opened), 'hi')

  const cut = async (socketPath: string, after?: () => Promise<void>): Promise<void> => {
    const socket = createConnection(socketPath)
    socket.on('error', () => {})
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    socket.write('hi')
    await after?.()
    await closed
  }
  await cut(join(layout.sockets, 'echo.sock'), async () => { (await until(() => streams[1])).close(constants.NGHTTP2_CANCEL) })
  await cut(join(layout.sockets, 'gone.sock'))
})

/** Once `found` finds something, as the streams come in. */
async function until<T>(found: () => T | undefined): Promise<T> {
  for (;;) {
    const value = found()
    if (value !== undefined) return value
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}
