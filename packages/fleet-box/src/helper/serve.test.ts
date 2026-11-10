import assert from 'node:assert/strict'
import { existsSync, readlinkSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { SERVICES_VARIABLE } from '@sleepymug/fleet-protocol/layout'
import type { HelperMessage, HostMessage, ServiceInBox } from '@sleepymug/fleet-protocol/helper'
import type { ServicesLayout } from './cmd/services.ts'
import { serve } from './serve.ts'

/** A request's answer, with the events before it. */
type Answer = Extract<HelperMessage, { id: number }> & { value?: unknown; events: unknown[] }

/** A helper served in this process, as the host talks to it: requests answered by id, and what else it sends, kept. */
class Served {
  readonly input = new PassThrough()
  readonly output = new PassThrough()
  /** What the helper sent that answers no request, such as a relayed connection's messages. */
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

  write(message: HostMessage | string): void {
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
  return { work, layout: { services: join(work, 'services'), bin: join(work, 'bin'), sockets: join(work, 'sockets') } }
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
  // As the host copies a service's package in.
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

  // A program in the box opens the service's socket; the host answers for the service.
  const socket = createConnection(join(layout.sockets, 'notes.sock'))
  let answer = ''
  socket.on('data', (chunk: Buffer) => { answer += chunk.toString('utf8') })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  socket.write('add milk\n')
  socket.end()
  const opened = await helper.until(() => helper.sent.find(message => message.type === 'conn-open'))
  assert.deepEqual(opened, { type: 'conn-open', conn: 1, service: 'notes' })
  await helper.until(() => helper.sent.find(message => message.type === 'conn-end'))
  const data = helper.sent.filter(message => message.type === 'conn-data').map(message => Buffer.from((message as { data: string }).data, 'base64').toString('utf8')).join('')
  assert.equal(data, 'add milk\n')
  helper.write({ type: 'conn-ack', conn: 1, bytes: data.length })
  helper.write({ type: 'conn-data', conn: 1, data: Buffer.from('added\n').toString('base64') })
  helper.write({ type: 'conn-end', conn: 1 })
  await closed
  assert.equal(answer, 'added\n')
  await helper.until(() => helper.sent.find(message => message.type === 'conn-ack'))
  assert.deepEqual(helper.sent.find(message => message.type === 'conn-ack'), { type: 'conn-ack', conn: 1, bytes: 6 })
  assert.equal(helper.sent.filter(message => message.type === 'conn-end').length, 1, 'a connection ended by both sides is not cut')

  // Synced without it, the box has none of it but its package.
  assert.equal((await helper.request('services.sync', { services: [] })).type, 'result')
  assert.equal(existsSync(join(layout.bin, 'notes')), false)
  assert.equal(existsSync(join(layout.services, 'notes')), false)
  assert.equal(existsSync(pkg), true)
  const gone = await helper.request('spawn', { process: 'm', argv: ['sh', '-c', 'printf "%s" "${NOTES_AT-unset}"'], cwd: work, env: {}, stdin: null, graceMs: 1000 })
  assert.equal(stdout(gone), 'unset')
  assert.equal((await helper.request('services.sync', { services: [{ ...notes, digest: 'fedcba9876543210' }] })).type, 'error')
})

test('a connection the box\'s side closes is ended on the host\'s, and one the host cuts is cut in the box', async (t) => {
  const { work, layout } = await scratch(t)
  const helper = new Served({ PATH: process.env.PATH }, work, layout)
  t.after(() => helper.close())
  await mkdir(join(layout.services, 'echo@aaaaaaaa'), { recursive: true })
  await helper.request('services.sync', { services: [{ name: 'echo', digest: 'aaaaaaaa', bins: {}, env: {} }] })
  const first = createConnection(join(layout.sockets, 'echo.sock'))
  await helper.until(() => helper.sent.find(message => message.type === 'conn-open'))
  // A closed socket's end is all its other side sees of it, as a request's end, after which the service answers no one.
  first.destroy()
  const ended = await helper.until(() => helper.sent.find(message => message.type === 'conn-end'))
  assert.deepEqual(ended, { type: 'conn-end', conn: 1 })

  const second = createConnection(join(layout.sockets, 'echo.sock'))
  second.on('error', () => {})
  const closed = new Promise<void>((resolve) => { second.once('close', () => { resolve() }) })
  await helper.until(() => helper.sent.find(message => message.type === 'conn-open' && message.conn === 2))
  helper.write({ type: 'conn-end', conn: 2, error: 'the service went away' })
  await closed
})
