/**
 * Tunnels: a connection its dialer serves over. The dialer asks for an
 * upgrade, as HTTP/1.1 has it, saying in its headers what it serves; once
 * the listener answers 101, the connection carries HTTP/2, the listener
 * the client and the dialer the server. So a server that cannot be dialed,
 * on another machine, behind its own network, is reached all the same.
 * @module @sleepymug/fleet-net/tunnel
 */

import { request, STATUS_CODES, type IncomingMessage } from 'node:http'
import { connect as connectHttp2, type ClientHttp2Session, type Http2Server } from 'node:http2'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { AUTHORITY, sessionUpstream, type Upstream } from './upstream.ts'

/** A tunnel's dialer's end. */
export interface Tunnel {
  /** Settles once the connection is closed, by either end. */
  readonly closed: Promise<void>
  /** Close the connection. */
  close(): void
}

/** An upgrade the listener answered with other than 101. */
export class TunnelRefused extends Error {
  constructor(
    /** The listener's status. */
    readonly status: number,
    /** Its headers. */
    readonly headers: IncomingMessage['headers'],
    /** What it said, its body. */
    message: string,
  ) {
    super(message === '' ? `the tunnel was refused: ${status} ${STATUS_CODES[status] ?? ''}` : message)
  }
}

export interface OpenTunnel {
  /** The listener's socket. */
  socket: string
  /** Where the upgrade is asked. */
  path: string
  /** The protocol it upgrades to. */
  protocol: string
  /** What the dialer says of itself, and of what it serves. */
  headers: Readonly<Record<string, string>>
  /** What serves the calls that come over it: HTTP/2, as a Connect router would be served. */
  server: Http2Server
}

/** Dial a listener, ask it for a tunnel, and serve `server` over it once it answers. */
export function openTunnel({ socket, path, protocol, headers, server }: OpenTunnel): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const upgrade = request({ socketPath: socket, path, method: 'GET', headers: { ...headers, connection: 'Upgrade', upgrade: protocol } })
    upgrade.once('upgrade', (_res, connection: Socket, head: Buffer) => {
      if (head.length > 0) connection.unshift(head)
      const closed = new Promise<void>((settle) => { connection.once('close', () => { settle() }) })
      connection.on('error', () => { connection.destroy() })
      server.emit('connection', connection)
      resolve({ closed, close: () => { connection.destroy() } })
    })
    upgrade.once('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.once('end', () => { reject(new TunnelRefused(res.statusCode ?? 0, res.headers, body.trim())) })
      res.once('error', reject)
    })
    upgrade.once('error', reject)
    upgrade.end()
  })
}

/** A tunnel's listener's end. */
export interface AcceptedTunnel {
  /** Calls to the dialer go through it. */
  readonly upstream: Upstream
  readonly session: ClientHttp2Session
  /** Settles once the connection is closed, by either end. */
  readonly closed: Promise<void>
  close(): void
}

/** Answer an upgrade with 101, and call the dialer over its connection. */
export function acceptTunnel(connection: Duplex, head: Buffer, protocol: string): AcceptedTunnel {
  connection.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${protocol}\r\n\r\n`)
  if (head.length > 0) connection.unshift(head)
  const session = connectHttp2(`http://${AUTHORITY}`, { createConnection: () => connection as Socket })
  // What fails on it fails its calls, which their callers are told.
  session.on('error', () => {})
  const closed = new Promise<void>((settle) => { session.once('close', () => { settle() }) })
  return { upstream: sessionUpstream(session), session, closed, close: () => { session.destroy() } }
}

/** Refuse an upgrade: `status`, with `headers`, and `message` as its body; then close the connection. */
export function refuseTunnel(connection: Duplex, status: number, message: string, headers: Readonly<Record<string, string>> = {}): void {
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
