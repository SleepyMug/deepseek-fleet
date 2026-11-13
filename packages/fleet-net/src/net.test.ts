import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer as createHttp2Server } from 'node:http2'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { duplexPair } from 'node:stream'
import { test } from 'node:test'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError, createClient, type ConnectRouter } from '@connectrpc/connect'
import { connectNodeAdapter, createConnectTransport, createGrpcTransport } from '@connectrpc/connect-node'
import { Box, WriteFileRequestSchema } from '@sleepymug/fleet-protocol/box'
import { FailureSchema, Reason } from '@sleepymug/fleet-protocol/gateway'
import { AUTHORITY, connectTransport, dial, forward, listen, openTunnel, refuse, TunnelRefused, webSocketStream, type AcceptedTunnel, type TunnelVia } from './index.ts'

/** A server of the test's: which answers with what it is asked and who said so, reads a file of n bytes, writes one, and waits on a stream until cancelled. */
function routes(seen: { cancelled: boolean; caller?: string }) {
  return (router: ConnectRouter) => router.service(Box, {
    which: (req, ctx) => ({ path: `/bin/${req.command} for ${ctx.requestHeader.get('x-caller') ?? 'nobody'}` }),
    async *readFile(req, ctx) {
      if (req.path === '/forever') {
        await new Promise<void>((resolve) => { ctx.signal.addEventListener('abort', () => { seen.cancelled = true; resolve() }) })
        return
      }
      for (let i = 0; i < 3; i++) yield { chunk: Buffer.from(`${req.path}:${i};`) }
    },
    async writeFile(requests) {
      let size = 0
      for await (const part of requests) if (part.request.case === 'chunk') size += part.request.value.length
      return { size: BigInt(size) }
    },
  })
}

async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-net-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('one socket takes HTTP/2 and HTTP/1.1 calls alike', async (t) => {
  const dir = await folder(t)
  const listener = await listen(join(dir, 's.sock'), { request: connectNodeAdapter({ routes: routes({ cancelled: false }) }) })
  t.after(() => listener.close())
  const upstream = dial(listener.path)
  t.after(() => { upstream.close() })
  const box = createClient(Box, connectTransport(upstream))
  assert.equal((await box.which({ command: 'ls' })).path, '/bin/ls for nobody')
  const http1 = createClient(Box, createConnectTransport({ baseUrl: `http://${AUTHORITY}`, httpVersion: '1.1', nodeOptions: { socketPath: listener.path } }))
  assert.equal((await http1.which({ command: 'cat' })).path, '/bin/cat for nobody')
})

test('a socket served by another process is not taken over; one no one answers on is', async (t) => {
  const dir = await folder(t)
  const path = join(dir, 's.sock')
  const first = await listen(path, { request: (_req, res) => { res.end() } })
  await assert.rejects(listen(path, { request: () => {} }), /another process serves/u)
  await first.close()
  const second = await listen(path, { request: (_req, res) => { res.end() } })
  await second.close()
})

/** A gateway of the test's: it takes tunnels named by `x-name`, and carries `/to/<name>/...` to that tunnel, saying who calls. */
async function gateway(t: { after: (fn: () => Promise<void>) => void }, dir: string) {
  const tunnels = new Map<string, AcceptedTunnel>()
  const accepted = new Map<string, AcceptedTunnel>()
  const listener = await listen(join(dir, 'gateway.sock'), {
    request: (req, res) => {
      const match = /^\/(to|stale)\/([^/]+)(\/.*)$/u.exec(req.url ?? '')
      // `stale` reaches a tunnel even once it is closed.
      const tunnel = match === null ? undefined : (match[1] === 'to' ? tunnels : accepted).get(match[2] as string)
      if (match === null || tunnel === undefined) {
        refuse(req, res, new ConnectError('no such server', Code.NotFound, undefined, [{ desc: FailureSchema, value: { reason: Reason.NO_SERVICE } }]))
        return
      }
      forward(req, res, tunnel.upstream, { path: match[3] as string, headers: { 'x-caller': 'the gateway' }, drop: name => name === 'x-caller' })
    },
    tunnel: (request) => {
      const name = String(request.headers['x-name'] ?? '')
      if (name === 'refused' || request.path !== '/tunnel' || !request.protocols.includes('test-tunnel')) {
        request.refuse(409, 'that name is taken', { 'x-reason': 'TAKEN' })
        return
      }
      const tunnel = request.accept('test-tunnel')
      tunnels.set(name, tunnel)
      accepted.set(name, tunnel)
      void tunnel.closed.then(() => { if (tunnels.get(name) === tunnel) tunnels.delete(name) })
    },
  })
  t.after(() => listener.close())
  return { listener, tunnels, accepted }
}

for (const via of ['http1', 'http2'] as TunnelVia[]) test(`a tunnel's dialer, its WebSocket opened over ${via}, serves the calls carried to it, every protocol alike, streams both ways, with the carrier's headers`, async (t) => {
  const dir = await folder(t)
  const { listener, tunnels } = await gateway(t, dir)
  const seen = { cancelled: false }
  const server = createHttp2Server(connectNodeAdapter({ routes: routes(seen) }))
  const tunnel = await openTunnel({ socket: listener.path, path: '/tunnel', protocol: 'test-tunnel', headers: { 'x-name': 'files' }, server, via })
  t.after(() => { tunnel.close() })
  assert.ok(tunnels.has('files'))

  const upstream = dial(listener.path)
  t.after(() => { upstream.close() })
  const box = createClient(Box, connectTransport(upstream, '/to/files'))
  assert.equal((await box.which({ command: 'ls' }, { headers: { 'x-caller': 'a liar' } })).path, '/bin/ls for the gateway')
  const read: string[] = []
  for await (const { chunk } of box.readFile({ path: '/a' })) read.push(Buffer.from(chunk).toString())
  assert.deepEqual(read, ['/a:0;', '/a:1;', '/a:2;'])
  async function* parts() {
    yield create(WriteFileRequestSchema, { request: { case: 'start', value: { path: '/b' } } })
    for (let i = 0; i < 4; i++) yield { request: { case: 'chunk' as const, value: Buffer.alloc(1000) } }
    yield { request: { case: 'chunk' as const, value: Buffer.alloc(3_000_000, 7) } }
  }
  assert.equal((await box.writeFile(parts())).size, 3_004_000n)

  const grpc = createClient(Box, createGrpcTransport({ baseUrl: `http://${AUTHORITY}/to/files`, nodeOptions: { createConnection: () => connect(listener.path) } }))
  const grpcRead: string[] = []
  for await (const { chunk } of grpc.readFile({ path: '/g' })) grpcRead.push(Buffer.from(chunk).toString())
  assert.deepEqual(grpcRead, ['/g:0;', '/g:1;', '/g:2;'])

  const answer = await new Promise<string>((resolve, reject) => {
    const call = request({ socketPath: listener.path, path: '/to/files/fleet.box.v1.Box/Which', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { resolve(body) })
    })
    call.on('error', reject)
    call.end(JSON.stringify({ command: 'curl' }))
  })
  assert.deepEqual(JSON.parse(answer), { path: '/bin/curl for the gateway' })

  const controller = new AbortController()
  const forever = (async () => { for await (const _ of box.readFile({ path: '/forever' }, { signal: controller.signal })) { /* nothing comes */ } })()
  await new Promise(resolve => setTimeout(resolve, 100))
  controller.abort()
  await assert.rejects(forever, (error: unknown) => ConnectError.from(error).code === Code.Canceled)
  for (let i = 0; i < 50 && !seen.cancelled; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(seen.cancelled, 'the server saw the call cancelled')

  tunnel.close()
  await tunnel.closed
  for (let i = 0; i < 50 && tunnels.has('files'); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(tunnels.has('files'), false)
})

test('a refused call reaches each protocol\'s client as the server\'s own error, with its details', async (t) => {
  const dir = await folder(t)
  const { listener } = await gateway(t, dir)
  const upstream = dial(listener.path)
  t.after(() => { upstream.close() })
  const reasonOf = (error: unknown): Reason | undefined => ConnectError.from(error).findDetails(FailureSchema)[0]?.reason
  const viaConnect = createClient(Box, connectTransport(upstream, '/to/nowhere'))
  await assert.rejects(viaConnect.which({ command: 'ls' }), (error: unknown) => ConnectError.from(error).code === Code.NotFound && reasonOf(error) === Reason.NO_SERVICE)
  await assert.rejects((async () => { for await (const _ of viaConnect.readFile({ path: '/' })) { /* none */ } })(),
    (error: unknown) => ConnectError.from(error).code === Code.NotFound && reasonOf(error) === Reason.NO_SERVICE)
  const grpc = createClient(Box, createGrpcTransport({ baseUrl: `http://${AUTHORITY}/to/nowhere`, nodeOptions: { createConnection: () => connect(listener.path) } }))
  await assert.rejects(grpc.which({ command: 'ls' }), (error: unknown) => ConnectError.from(error).code === Code.NotFound && reasonOf(error) === Reason.NO_SERVICE)
})

for (const via of ['http1', 'http2'] as TunnelVia[]) test(`a refused tunnel, over ${via}, says why`, async (t) => {
  const dir = await folder(t)
  const { listener } = await gateway(t, dir)
  await assert.rejects(
    openTunnel({ socket: listener.path, path: '/tunnel', protocol: 'test-tunnel', headers: { 'x-name': 'refused' }, server: createHttp2Server(), via }),
    (error: unknown) => error instanceof TunnelRefused && error.status === 409 && error.headers['x-reason'] === 'TAKEN' && error.message === 'that name is taken',
  )
})

test('a tunnel whose dialer is gone fails the calls carried to it as unavailable', async (t) => {
  const dir = await folder(t)
  const { listener, accepted } = await gateway(t, dir)
  const tunnel = await openTunnel({ socket: listener.path, path: '/tunnel', protocol: 'test-tunnel', headers: { 'x-name': 'gone' }, server: createHttp2Server(connectNodeAdapter({ routes: routes({ cancelled: false }) })) })
  tunnel.close()
  await (accepted.get('gone') as AcceptedTunnel).closed
  const upstream = dial(listener.path)
  t.after(() => { upstream.close() })
  const box = createClient(Box, connectTransport(upstream, '/stale/gone'))
  await assert.rejects(box.which({ command: 'ls' }), (error: unknown) => ConnectError.from(error).code === Code.Unavailable)
})

test('an upgrade that is not a WebSocket\'s is refused, and a listener without tunnels takes no CONNECT', async (t) => {
  const dir = await folder(t)
  const { listener } = await gateway(t, dir)
  const status = await new Promise<number>((resolve, reject) => {
    const upgrade = request({ socketPath: listener.path, path: '/tunnel', headers: { connection: 'Upgrade', upgrade: 'test-tunnel' } })
    upgrade.once('response', (res) => { resolve(res.statusCode ?? 0) })
    upgrade.once('upgrade', () => { reject(new Error('upgraded')) })
    upgrade.once('error', reject)
    upgrade.end()
  })
  assert.equal(status, 400)
  const plain = await listen(join(dir, 'plain.sock'), { request: (_req, res) => { res.end() } })
  t.after(() => plain.close())
  await assert.rejects(openTunnel({ socket: plain.path, path: '/tunnel', protocol: 'test-tunnel', headers: {}, server: createHttp2Server(), via: 'http2' }), /no extended CONNECT/u)
})

test('a WebSocket carries bytes as they are, however its frames are cut, and answers pings', async () => {
  const [a, b] = duplexPair()
  const client = webSocketStream(a, 'client')
  const server = webSocketStream(b, 'server')
  const sizes = [0, 1, 125, 126, 65535, 65536, 200_000]
  const sent = Buffer.concat(sizes.map((size, i) => Buffer.alloc(size, i + 1)))
  const received: Buffer[] = []
  server.on('data', (chunk: Buffer) => { received.push(chunk) })
  const ended = new Promise<void>((resolve) => { server.once('end', resolve) })
  const closed = new Promise<void>((resolve) => { client.once('close', resolve) })
  // A ping from the server, unmasked as a server's frames are, is answered with a pong, which the server takes and passes nothing on of.
  b.write(Buffer.from([0x89, 0x02, 0x68, 0x69]))
  for (const size of sizes) client.write(Buffer.alloc(size, sizes.indexOf(size) + 1))
  client.end()
  await ended
  assert.ok(Buffer.concat(received).equals(sent))
  await closed
})
