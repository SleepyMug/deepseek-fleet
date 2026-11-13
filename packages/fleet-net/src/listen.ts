/**
 * A Unix socket that takes HTTP/1.1 and HTTP/2 alike: each connection is
 * HTTP/2 when it opens with HTTP/2's preface, as a Connect or gRPC client's
 * does, and HTTP/1.1 otherwise, as curl's and a tunnel's upgrade are. Both
 * are handed to one handler, as Node's servers give them, so a Connect
 * router serves either.
 * @module @sleepymug/fleet-net/listen
 */

import { chmod, rm } from 'node:fs/promises'
import { createServer as createHttp1Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttp2Server, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2'
import { connect, createServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export type Request = IncomingMessage | Http2ServerRequest
export type Response = ServerResponse | Http2ServerResponse

/** Serves a request, HTTP/1.1 or HTTP/2. */
export type Handler = (req: Request, res: Response) => void

/** Takes an HTTP/1.1 upgrade: the request, its connection, and what came after the request on it. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

export interface ListenOptions {
  /** Every request, HTTP/1.1 or HTTP/2. */
  request: Handler
  /** Every HTTP/1.1 upgrade; without it, an upgrade's connection is closed. */
  upgrade?: UpgradeHandler
  /** The socket's permission bits; 0600, its owner's alone, without them. */
  mode?: number
}

export interface Listener {
  readonly path: string
  /** Stop listening, end every connection, and remove the socket. */
  close(): Promise<void>
}

/** HTTP/2's connection preface, which a client sends first. */
const PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1')

/**
 * Listen on a Unix socket at `path`, taking it over if it is there and no
 * one answers on it.
 * @throws when another process serves on it.
 */
export async function listen(path: string, options: ListenOptions): Promise<Listener> {
  await claim(path)
  const http2 = createHttp2Server({}, options.request)
  const http1 = createHttp1Server(options.request)
  http1.on('upgrade', options.upgrade ?? ((_req: IncomingMessage, socket: Duplex) => { socket.destroy() }))
  // A client that breaks its protocol loses its connection, not the listener.
  http2.on('sessionError', () => {})
  http1.on('clientError', (_error, socket: Duplex) => { socket.destroy() })
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    socket.on('error', () => { socket.destroy() })
    sniff(socket).then(
      isHttp2 => (isHttp2 ? http2 : http1).emit('connection', socket),
      () => { socket.destroy() },
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(path, options.mode ?? 0o600)
  let closing: Promise<void> | undefined
  return {
    path,
    close: () => {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
        for (const socket of sockets) socket.destroy()
        http2.close()
        http1.closeAllConnections()
        await closed
        await rm(path, { force: true })
      })()
      return closing
    },
  }
}

/** Whether a connection opens with HTTP/2's preface, reading no more than tells, and leaving what it read to be read again. */
function sniff(socket: Socket): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let read = Buffer.alloc(0)
    const done = (isHttp2: boolean): void => {
      socket.off('readable', onReadable)
      socket.off('error', reject)
      socket.off('end', onEnd)
      socket.unshift(read)
      resolve(isHttp2)
    }
    const onEnd = (): void => { reject(new Error('the connection ended before its first request')) }
    const onReadable = (): void => {
      for (let chunk: Buffer | null = socket.read() as Buffer | null; chunk !== null; chunk = socket.read() as Buffer | null) {
        read = Buffer.concat([read, chunk])
      }
      const length = Math.min(read.length, PREFACE.length)
      const matches = read.subarray(0, length).equals(PREFACE.subarray(0, length))
      if (!matches) done(false)
      else if (length === PREFACE.length) done(true)
    }
    socket.on('readable', onReadable)
    socket.once('error', reject)
    socket.once('end', onEnd)
  })
}

/** Make `path` free to listen on: a socket no one answers on is removed. */
async function claim(path: string): Promise<void> {
  const answered = await new Promise<boolean>((resolve) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => { resolve(false) })
  })
  if (answered) throw new Error(`another process serves on ${path}`)
  await rm(path, { force: true })
}
