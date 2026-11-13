import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Fleet, type BoxState } from '@sleepymug/fleet-sdk'
import { FLEET_PROTOCOL } from '@sleepymug/fleet-protocol/fleet'
import { FleetGateway } from './gateway.ts'
import { LocalBoxes } from './local-boxes.test.util.ts'
import { systemPlatform } from './platform.ts'
import { Registry } from './registry.ts'
import { listen } from './socket.ts'

/** A gateway of the test's, on a socket of its own, its boxes local ones (./local-boxes.test.util.ts). */
async function serving(t: { after: (fn: () => Promise<void>) => void }, idleStopMs = 60_000): Promise<{ dir: string; socket: string; boxes: LocalBoxes; client: Fleet; gateway: FleetGateway }> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-gateway-'))
  const boxes = new LocalBoxes(join(dir, 'boxes'))
  const gateway = new FleetGateway({ registry: new Registry(join(dir, 'registry')), cache: join(dir, 'cache'), channels: join(dir, 'channels'), platform: systemPlatform(() => {}), boxes, idleStopMs })
  await gateway.load()
  const socket = join(dir, 'fleet.sock')
  const close = await listen(socket, gateway)
  const client = await Fleet.connect({ socket })
  t.after(async () => {
    await client.close()
    await close()
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, socket, boxes, client, gateway }
}

/** A service's package, whose command `shout` sends its words to the service, and prints the answer. */
async function shoutPackage(dir: string): Promise<string> {
  const root = join(dir, 'shout-box')
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'shout-box', version: '1.0.0', type: 'module', files: ['bin'], bin: { shout: 'bin/shout.js' } }))
  await writeFile(join(root, 'bin', 'shout.js'), [
    '#!/usr/bin/env node',
    'import { createConnection } from "node:net"',
    'const socket = createConnection(`${process.env.FLEET_SERVICES}/shout.sock`)',
    'let answer = ""',
    'socket.on("data", (chunk) => { answer += chunk })',
    'socket.on("end", () => { process.stdout.write(`${answer} (${process.env.SHOUT_LOUDNESS})`) })',
    'socket.end(process.argv.slice(2).join(" "))',
  ].join('\n'))
  await chmod(join(root, 'bin', 'shout.js'), 0o644)
  return root
}

test('a service registered is put in each box that has it: its command on the PATH, which reaches the service, told the box', async (t) => {
  const { dir, client } = await serving(t)
  const shouted: string[] = []
  const registration = await client.register({
    name: 'shout',
    description: 'Shouts.',
    package: await shoutPackage(dir),
    env: { SHOUT_LOUDNESS: 'loud' },
    serve(connection, from) {
      let text = ''
      connection.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      connection.on('end', () => {
        shouted.push(from.labels.who ?? '')
        connection.end(`${text.toUpperCase()} from ${from.box}`)
      })
    },
  })
  assert.deepEqual(registration.info.bins, { shout: 'bin/shout.js' })
  assert.deepEqual((await client.request('service.list', {})).map(({ name, description }) => [name, description]), [['shout', 'Shouts.']])

  const { id } = await client.create({ labels: { who: 'tester' } })
  const box = client.box(id)
  assert.equal(await box.exec(['sh', '-c', 'shout hello there']), `HELLO THERE from ${id} (loud)`)
  assert.deepEqual(shouted, ['tester'])
  const other = await client.create({ services: [] })
  await assert.rejects(client.box(other.id).exec(['sh', '-c', 'shout hi']), /shout: not found/u)

  // Unregistered, the started box loses its command, and a box made later never gets it.
  await registration.unregister()
  for (let tries = 0; ; tries++) {
    const which = await box.request('exec', { argv: ['sh', '-c', 'command -v shout || echo none'] })
    if (which.stdout.trim() === 'none') break
    assert.ok(tries < 50, 'the command is gone')
    await delay(20)
  }
})

test('a box started for its lease stops once nothing has occupied it for its idle time, and its state is followed', async (t) => {
  const { client } = await serving(t, 100)
  const { id } = await client.create()
  const box = client.box(id)
  const states: (BoxState | 'removed')[] = []
  const unwatch = box.watch((state) => { states.push(state) })
  const release = await box.lease({ kind: 'test', id: 'one' })
  assert.equal((await box.get()).state, 'started')
  await delay(250)
  assert.equal((await box.get()).state, 'started', 'a box occupied is not stopped')
  await release()
  await delay(300)
  assert.equal((await box.get()).state, 'stopped')
  // Occupied without starting it, it starts for a request, and stays up after it.
  const occupied = await box.lease({ kind: 'test', id: 'two' }, { start: false })
  assert.equal((await box.get()).state, 'stopped')
  assert.deepEqual(await box.request('echo', { text: 'up' }), { text: 'up' })
  await delay(250)
  assert.equal((await box.get()).state, 'started')
  await occupied()
  await box.remove()
  await delay(50)
  unwatch()
  assert.deepEqual(states, ['stopped', 'started', 'stopping', 'stopped', 'started', 'removed'])
})

test('a box whose container was removed by other means is gone, and its owner makes another', async (t) => {
  const { client, boxes } = await serving(t)
  const { id } = await client.create()
  await boxes.lose(id)
  await assert.rejects(client.box(id).lease({ kind: 'test', id: 'gone' }), (error: Error & { code?: string }) => error.code === 'BOX_GONE')
  assert.equal((await client.box(id).get()).state, 'gone')
  await assert.rejects(client.box('box-0000000000000000').get(), (error: Error & { code?: string }) => error.code === 'NO_BOX')
  // A request of a box that is not started, without holding it, fails as such.
  const { id: other } = await client.create()
  await assert.rejects(client.box(other).request('echo', { text: 'x' }, { hold: false }), (error: Error & { code?: string }) => error.code === 'NOT_STARTED')
})

test('a client whose connection is reset, as by a process killed with the gateway\'s answers unread, leaves the gateway serving the others', async (t) => {
  const { socket, client } = await serving(t)
  const raw = createConnection(socket)
  raw.on('error', () => {})
  // Never read, so that closing it with the gateway's answers unread resets it.
  raw.pause()
  raw.write(`${JSON.stringify({ type: 'hello', protocol: FLEET_PROTOCOL })}\n`)
  for (let id = 1; id <= 50; id++) raw.write(`${JSON.stringify({ type: 'request', id, op: 'box.list', params: {} })}\n`)
  await delay(200)
  raw.destroy()
  await delay(200)
  assert.deepEqual(await client.list(), [])
})

test('a client\'s leases go with its connection, so a box it held stops once idle', async (t) => {
  const { socket, client } = await serving(t, 100)
  const { id } = await client.create()
  const other = await Fleet.connect({ socket })
  await other.box(id).lease({ kind: 'test', id: 'held' })
  await delay(200)
  assert.equal((await client.box(id).get()).state, 'started')
  await other.close()
  await delay(300)
  assert.equal((await client.box(id).get()).state, 'stopped')
})

test('a gateway started later knows the boxes made before, and a client takes its service and leases back from it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-gateway-again-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const boxes = new LocalBoxes(join(dir, 'boxes'))
  const socket = join(dir, 'fleet.sock')
  const start = async (): Promise<{ gateway: FleetGateway; close: () => Promise<void> }> => {
    const gateway = new FleetGateway({ registry: new Registry(join(dir, 'registry')), cache: join(dir, 'cache'), channels: join(dir, 'channels'), platform: systemPlatform(() => {}), boxes })
    await gateway.load()
    return { gateway, close: await listen(socket, gateway) }
  }
  let first = await start()
  const logged: string[] = []
  const client = await Fleet.connect({ socket, log: (message) => { logged.push(message) } })
  t.after(() => client.close())
  await client.register({ name: 'shout', description: 'Shouts.', package: await shoutPackage(dir), serve: connection => connection.end('HI') })
  const { id } = await client.create()
  await client.box(id).lease({ kind: 'test', id: 'kept' })
  await first.close()
  await first.gateway.close()
  first = await start()
  t.after(async () => {
    await first.close()
    await first.gateway.close()
  })
  for (let tries = 0; first.gateway.services.list().length === 0; tries++) {
    assert.ok(tries < 100, 'the service is registered again')
    await delay(50)
  }
  assert.equal((await client.box(id).get()).id, id)
  assert.equal(await client.box(id).exec(['sh', '-c', 'shout']), 'HI (undefined)')
  assert.ok(logged.some(message => message.startsWith('connected again')))
})

/** The image the Docker tests' boxes run: $FLEET_TEST_IMAGE, or the default. */
const IMAGE = process.env.FLEET_TEST_IMAGE ?? 'fleet:local'
const noImage = await new Promise<string | false>((resolve) => {
  execFile('docker', ['image', 'inspect', IMAGE], (error) => { resolve(error === null ? false : `no Docker image ${IMAGE}; build it with \`pnpm image\``) })
})

test('in a Docker box, a service\'s package is copied in, its command runs on the box\'s Node, and its connections reach the service', { skip: noImage }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-gateway-docker-'))
  const gateway = new FleetGateway({ registry: new Registry(join(dir, 'registry')), cache: join(dir, 'cache'), channels: join(dir, 'channels'), platform: systemPlatform(() => {}), image: IMAGE })
  const socket = join(dir, 'fleet.sock')
  const close = await listen(socket, gateway)
  const client = await Fleet.connect({ socket })
  let id: string | undefined
  t.after(async () => {
    if (id !== undefined) await client.box(id).remove().catch(() => {})
    await client.close()
    await close()
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  })
  await client.register({
    name: 'shout', description: 'Shouts.', package: await shoutPackage(dir), env: { SHOUT_LOUDNESS: 'very' },
    serve(connection, from) {
      let text = ''
      connection.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      connection.on('end', () => { connection.end(`${text.toUpperCase()} from ${from.box}`) })
    },
  })
  id = (await client.create()).id
  assert.equal(await client.box(id).exec(['sh', '-c', 'shout from docker']), `FROM DOCKER from ${id} (very)`)
})
