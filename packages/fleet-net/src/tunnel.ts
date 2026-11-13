/**
 * Tunnels: a connection its dialer serves over. The dialer opens a
 * WebSocket, as every proxy that passes WebSockets passes it: an HTTP/1.1
 * upgrade, or an HTTP/2 extended CONNECT (RFC 8441), naming the
 * subprotocol it speaks and saying in its headers what it serves. Once the
 * listener takes it, the WebSocket carries HTTP/2, the listener the client
 * and the dialer the server. So a server that cannot be dialed, on another
 * machine, behind its own network, is reached all the same.
 * @module @sleepymug/fleet-net/tunnel
 */

import { request, STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { connect as connectHttp2, type ClientHttp2Session, type Http2Server, type IncomingHttpHeaders as Http2Headers, type ServerHttp2Stream } from 'node:http2'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { AUTHORITY, sessionUpstream, type Upstream } from './upstream.ts'
import { WEBSOCKET_VERSION, webSocketAccept, webSocketKey, webSocketProtocols, webSocketStream } from './websocket.ts'

/** How a tunnel is opened: an HTTP/1.1 upgrade, or an HTTP/2 extended CONNECT. */
export type TunnelVia = 'http1' | 'http2'

/** A tunnel's dialer's end. */
export interface Tunnel {
  /** Settles once the tunnel is closed, by either end. */
  readonly closed: Promise<void>
  /** Close the tunnel. */
  close(): void
}

/** A tunnel the listener answered with other than its taking it. */
export class TunnelRefused extends Error {
  constructor(
    /** The listener's status. */
    readonly status: number,
    /** Its headers. */
    readonly headers: IncomingHttpHeaders,
    /** What it said, its body. */
    message: string,
  ) {
    super(message === '' ? `the tunnel was refused: ${status} ${STATUS_CODES[status] ?? ''}` : message)
  }
}

export interface OpenTunnel {
  /** The listener's socket. */
  socket: string
  /** Where the tunnel is asked for. */
  path: string
  /** The WebSocket subprotocol it speaks. */
  protocol: string
  /** What the dialer says of itself, and of what it serves. */
  headers: Readonly<Record<string, string>>
  /** What serves the calls that come over it: HTTP/2, as a Connect router would be served. */
  server: Http2Server
  /** How it is opened; an HTTP/1.1 upgrade unless it says. */
  via?: TunnelVia
}

/** Dial a listener, ask it for a tunnel, and serve `server` over it once it is taken. */
export async function openTunnel(options: OpenTunnel): Promise<Tunnel> {
  const { stream, end } = await (options.via === 'http2' ? openOverHttp2(options) : openOverHttp1(options))
  const tunnel = webSocketStream(stream, 'client')
  const closed = new Promise<void>((settle) => {
    tunnel.once('close', () => {
      end()
      settle()
    })
  })
  tunnel.on('error', () => { tunnel.destroy() })
  options.server.emit('connection', tunnel)
  return { closed, close: () => { tunnel.destroy() } }
}

/** What a tunnel's opening leaves: the stream its WebSocket runs over, and how to end what carries that stream. */
interface Opened {
  stream: Duplex
  end: () => void
}

function openOverHttp1({ socket, path, protocol, headers }: OpenTunnel): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const key = webSocketKey()
    const upgrade = request({
      socketPath: socket,
      path,
      method: 'GET',
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': WEBSOCKET_VERSION,
        'sec-websocket-key': key,
        'sec-websocket-protocol': protocol,
      },
    })
    upgrade.once('upgrade', (res: IncomingMessage, connection: Duplex, head: Buffer) => {
      if (res.headers['sec-websocket-accept'] !== webSocketAccept(key) || res.headers['sec-websocket-protocol'] !== protocol) {
        connection.destroy()
        reject(new Error(`the listener did not take the WebSocket as ${protocol}`))
        return
      }
      if (head.length > 0) connection.unshift(head)
      resolve({ stream: connection, end: () => { connection.destroy() } })
    })
    upgrade.once('response', (res) => {
      readBody(res).then(body => { reject(new TunnelRefused(res.statusCode ?? 0, res.headers, body)) }, reject)
    })
    upgrade.once('error', reject)
    upgrade.end()
  })
}

function openOverHttp2({ socket, path, protocol, headers }: OpenTunnel): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const session = connectHttp2(`http://${AUTHORITY}`, { createConnection: () => connect(socket) })
    session.once('error', reject)
    session.once('remoteSettings', (settings) => {
      if (settings.enableConnectProtocol !== true) {
        session.destroy()
        reject(new Error('the listener takes no extended CONNECT'))
        return
      }
      const stream = session.request({
        ...headers,
        ':method': 'CONNECT',
        ':protocol': 'websocket',
        ':scheme': 'http',
        ':path': path,
        'sec-websocket-version': WEBSOCKET_VERSION,
        'sec-websocket-protocol': protocol,
      })
      stream.once('error', reject)
      stream.once('response', (response) => {
        const status = Number(response[':status'])
        if (status >= 200 && status < 300 && response['sec-websocket-protocol'] === protocol) {
          session.off('error', reject)
          stream.off('error', reject)
          // What fails on it ends the tunnel, which its dialer is told.
          session.on('error', () => {})
          resolve({ stream, end: () => { session.destroy() } })
          return
        }
        readBody(stream).then(
          (body) => { reject(new TunnelRefused(status, headersOf(response), body)) },
          reject,
        ).finally(() => { session.destroy() })
      })
    })
  })
}

async function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  let body = ''
  stream.setEncoding('utf8')
  for await (const chunk of stream) body += String(chunk)
  return body.trim()
}

/** HTTP/2's headers as HTTP/1.1's are given: its pseudo-headers left out. */
function headersOf(headers: Http2Headers): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(':')))
}

/** A tunnel's listener's end. */
export interface AcceptedTunnel {
  /** Calls to the dialer go through it. */
  readonly upstream: Upstream
  readonly session: ClientHttp2Session
  /** Settles once the tunnel is closed, by either end. */
  readonly closed: Promise<void>
  close(): void
}

/** A tunnel asked for, which its listener takes or refuses. */
export interface TunnelRequest {
  /** Where it is asked for. */
  readonly path: string
  /** What the dialer says, its headers. */
  readonly headers: IncomingHttpHeaders
  /** The subprotocols it offers, in its order. */
  readonly protocols: readonly string[]
  /** How it came. */
  readonly via: TunnelVia
  /** Take it, speaking `protocol`, one of those it offers, and call the dialer over it. */
  accept(protocol: string): AcceptedTunnel
  /** Refuse it: `status`, with `headers`, and `message` as its body. */
  refuse(status: number, message: string, headers?: Readonly<Record<string, string>>): void
}

/** Takes the tunnels asked of a listener. */
export type TunnelHandler = (request: TunnelRequest) => void

/** A tunnel asked for as an HTTP/1.1 upgrade; refused here unless it is a WebSocket's. */
export function upgradeRequest(req: IncomingMessage, connection: Duplex, head: Buffer): TunnelRequest | undefined {
  const refuse = (status: number, message: string, headers: Readonly<Record<string, string>> = {}): void => {
    const body = Buffer.from(`${message}\n`)
    const lines = [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${body.length}`,
      'Connection: close',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ]
    connection.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]))
  }
  const key = req.headers['sec-websocket-key']
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string') {
    refuse(400, 'a tunnel is a WebSocket')
    return undefined
  }
  if (req.headers['sec-websocket-version'] !== WEBSOCKET_VERSION) {
    refuse(426, `WebSocket's version is ${WEBSOCKET_VERSION}`, { 'Sec-WebSocket-Version': WEBSOCKET_VERSION })
    return undefined
  }
  return {
    path: req.url ?? '',
    headers: req.headers,
    protocols: webSocketProtocols(req.headers['sec-websocket-protocol']),
    via: 'http1',
    refuse,
    accept: (protocol) => {
      connection.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Accept: ${webSocketAccept(key)}`,
        `Sec-WebSocket-Protocol: ${protocol}`,
      ].join('\r\n') + '\r\n\r\n')
      if (head.length > 0) connection.unshift(head)
      return callOver(webSocketStream(connection, 'server'))
    },
  }
}

/** A tunnel asked for as an HTTP/2 extended CONNECT; refused here unless it is a WebSocket's. */
export function connectRequest(stream: ServerHttp2Stream, headers: Http2Headers): TunnelRequest | undefined {
  const refuse = (status: number, message: string, more: Readonly<Record<string, string>> = {}): void => {
    if (stream.destroyed) return
    stream.respond({
      ':status': status,
      'content-type': 'text/plain; charset=utf-8',
      ...Object.fromEntries(Object.entries(more).map(([name, value]) => [name.toLowerCase(), value])),
    })
    stream.end(`${message}\n`)
  }
  if (headers[':protocol'] !== 'websocket') {
    refuse(400, 'a tunnel is a WebSocket')
    return undefined
  }
  if (headers['sec-websocket-version'] !== WEBSOCKET_VERSION) {
    refuse(426, `WebSocket's version is ${WEBSOCKET_VERSION}`, { 'sec-websocket-version': WEBSOCKET_VERSION })
    return undefined
  }
  return {
    path: headers[':path'] ?? '',
    headers: headersOf(headers),
    protocols: webSocketProtocols(headers['sec-websocket-protocol']),
    via: 'http2',
    refuse,
    accept: (protocol) => {
      stream.respond({ ':status': 200, 'sec-websocket-protocol': protocol })
      return callOver(webSocketStream(stream, 'server'))
    },
  }
}

/** Call the dialer over `tunnel`, as an HTTP/2 client. */
function callOver(tunnel: Duplex): AcceptedTunnel {
  tunnel.on('error', () => { tunnel.destroy() })
  const session = connectHttp2(`http://${AUTHORITY}`, { createConnection: () => tunnel })
  // What fails on it fails its calls, which their callers are told.
  session.on('error', () => {})
  const closed = new Promise<void>((settle) => { session.once('close', () => { settle() }) })
  // The tunnel lost ends the session, even one whose dialer never said goodbye.
  tunnel.once('close', () => { session.destroy() })
  return { upstream: sessionUpstream(session), session, closed, close: () => { session.destroy(); tunnel.destroy() } }
}

/** A tunnel kept open: opened again whenever it closes, or fails to open, until stopped. */
export interface KeptTunnel {
  /** Settles once the tunnel is first open; fails if `fatal` says its first refusal is for good. */
  readonly opened: Promise<void>
  /** Stop: close the tunnel, and open it no more. */
  close(): void
}

export interface KeepTunnel {
  /** Open the tunnel once. */
  open: () => Promise<Tunnel>
  /** Told what goes wrong, as a tunnel refused or lost. */
  log?: (message: string) => void
  /** Before opening again after `open` failed with `error`, as by staging what the listener lacked. */
  recover?: (error: unknown) => Promise<void>
  /** Whether `open`'s failure, before the tunnel ever opened, is for good, which opening it again would not change. */
  fatal?: (error: unknown) => boolean
}

/**
 * Keep a tunnel open: open it, and once it closes, or fails to open, open
 * it again after a pause, a tenth of a second at first, twice as long each
 * time, up to two seconds, until it opens again, as after its listener
 * restarts.
 */
export function keepTunnel({ open, log = () => {}, recover, fatal }: KeepTunnel): KeptTunnel {
  let stopped = false
  let everOpened = false
  let current: Tunnel | undefined
  let wake: (() => void) | undefined
  const opened = Promise.withResolvers<void>()
  void (async () => {
    let pause = 100
    while (!stopped) {
      try {
        current = await open()
        if (stopped) {
          current.close()
          break
        }
        everOpened = true
        opened.resolve()
        pause = 100
        await current.closed
        current = undefined
        if (stopped) break
        log('the tunnel closed; opening it again')
      } catch (error) {
        if (!everOpened && fatal?.(error) === true) {
          stopped = true
          opened.reject(error)
          break
        }
        log(`the tunnel did not open: ${error instanceof Error ? error.message : String(error)}`)
        await recover?.(error).catch((failure: unknown) => { log(`could not recover: ${failure instanceof Error ? failure.message : String(failure)}`) })
      }
      if (stopped) break
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pause)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      pause = Math.min(pause * 2, 2000)
    }
  })()
  return {
    opened: opened.promise,
    close: () => {
      stopped = true
      current?.close()
      wake?.()
    },
  }
}
