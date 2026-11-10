import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { test } from 'node:test'
import { Helper } from './box/helper.ts'
import { Channel, channelSocket } from './channel.ts'

/** The helper as built, served on this Node, its services' things in the test's folder, its channel the host's there. */
function servedHelper(layout: { services: string; bin: string; sockets: string; channel: string }): readonly [string, ...string[]] {
  const serve = JSON.stringify(import.meta.resolve('@sleepymug/fleet-box/helper/serve'))
  const program = [
    `import { serve } from ${serve}`,
    `await serve({ input: process.stdin, output: process.stdout, env: process.env, cwd: process.cwd(), log: (message) => process.stderr.write(message), layout: ${JSON.stringify(layout)} })`,
    'process.exit(0)',
  ].join('\n')
  return [process.execPath, '--input-type=module', '--eval', program]
}

/** A box's channel and its helper, as the host has them, with the services `names` synced in, each connection taken by `take`. */
async function channelled(t: { after: (fn: () => Promise<void>) => void }, names: string[], take: (service: string) => ((stream: Duplex) => void) | undefined): Promise<{ helper: Helper; channel: Channel; sockets: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-channel-'))
  const layout = { services: join(dir, 'services'), bin: join(dir, 'bin'), sockets: join(dir, 'sockets'), channel: channelSocket(join(dir, 'channel')) }
  for (const name of names) await mkdir(join(layout.services, `${name}@00000000`), { recursive: true })
  const channel = await Channel.listen(join(dir, 'channel'), take)
  const helper = await Helper.start(servedHelper(layout))
  t.after(async () => {
    await helper.close()
    await channel.close()
    await rm(dir, { recursive: true, force: true })
  })
  await helper.request('services.sync', { services: names.map(name => ({ name, digest: '00000000', bins: {}, env: {} })) })
  return { helper, channel, sockets: layout.sockets }
}

/** A program in the box, run by its helper, that opens a service's socket, does `body`, and prints how much it read once the socket closed: a cut, as an end, is all a socket's reader sees. */
function client(socket: string, body: string): string[] {
  const program = [
    'import { createConnection } from "node:net"',
    `const socket = createConnection(${JSON.stringify(socket)})`,
    'let size = 0',
    'socket.on("data", (chunk) => { size += chunk.length })',
    'socket.on("error", () => {})',
    'socket.on("close", () => { process.stdout.write(String(size)) })',
    body,
  ].join('\n')
  return [process.execPath, '--input-type=module', '--eval', program]
}

test('a connection a program in the box opens to a service\'s socket reaches the host as a stream of the box\'s channel, its bytes both ways, more than a window of them, each end a half-close', async (t) => {
  const served: string[] = []
  const { helper, sockets } = await channelled(t, ['shout'], service => (connection) => {
    let size = 0
    connection.on('data', (chunk: Buffer) => { size += chunk.length })
    connection.on('end', () => {
      served.push(`${service} ${String(size)}`)
      for (let index = 0; index < 30; index++) connection.write(Buffer.alloc(100_000, 'D'))
      connection.end()
    })
  })
  const ran = await helper.request('exec', { argv: client(join(sockets, 'shout.sock'), 'for (let i = 0; i < 20; i++) socket.write(Buffer.alloc(100_000, "u"))\nsocket.end()') })
  assert.equal(ran.stderr, '')
  assert.equal(ran.stdout, '3000000')
  assert.deepEqual(served, ['shout 2000000'])
})

test('a connection to a service the host does not take is cut, and so is one the service cuts, or whose channel closes', async (t) => {
  const taken: Duplex[] = []
  const { helper, channel, sockets } = await channelled(t, ['none', 'echo'], service => service === 'none' ? undefined : (connection) => { taken.push(connection) })
  assert.equal((await helper.request('exec', { argv: client(join(sockets, 'none.sock'), 'socket.write("hi")') })).stdout, '0')

  const cutByService = helper.request('exec', { argv: client(join(sockets, 'echo.sock'), 'socket.write("hi")') })
  await until(() => taken[0])
  taken[0]?.destroy(new Error('the service went away'))
  assert.equal((await cutByService).stdout, '0')

  const cutByHost = helper.request('exec', { argv: client(join(sockets, 'echo.sock'), 'socket.write("hi")') })
  await until(() => taken[1])
  await channel.close()
  assert.equal((await cutByHost).stdout, '0')
})

async function until<T>(found: () => T | undefined): Promise<T> {
  for (;;) {
    const value = found()
    if (value !== undefined) return value
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}
