/**
 * The fleet host's socket (fleet-protocol's fleet wire): a Unix socket only
 * its owner can open, its folder made with mode 0700, on which each
 * connection is a client of the host, which says the wire's version first,
 * then asks ops, one JSON message a line, each answered once, its events
 * before; a request it cancels has its signal aborted. When the connection
 * ends, the client's requests are given up, and its leases and services go.
 * @module @sleepymug/fleet/server
 */

import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { FLEET_PROTOCOL, type ClientMessage, type HostMessage, type Op } from '@sleepymug/fleet-protocol/fleet'
import type { FleetHost } from './host.ts'
import { messageOf } from './util/error.ts'

/**
 * Serve the host on a socket at `socket`, taking over one that no host
 * answers on.
 * @returns what closes the socket and its connections.
 * @throws when a host already answers there.
 */
export async function listen(socket: string, host: FleetHost): Promise<() => Promise<void>> {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  await claim(socket)
  const connections = new Set<Socket>()
  const server = createServer((connection) => {
    connections.add(connection)
    connection.once('close', () => connections.delete(connection))
    serve(connection, host)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(socket, 0o600)
  return async () => {
    const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    for (const connection of connections) connection.destroy()
    await closed
  }
}

/** Serve one client's connection. */
export function serve(connection: Socket, host: FleetHost): void {
  const client = host.client()
  const inFlight = new Map<number, AbortController>()
  let greeted = false
  const send = (message: HostMessage): void => {
    if (!connection.destroyed) connection.write(`${JSON.stringify(message)}\n`)
  }
  connection.on('error', () => {})
  connection.once('close', () => {
    for (const controller of inFlight.values()) controller.abort(new Error('the client went away'))
    inFlight.clear()
    host.leave(client)
  })
  const lines = createInterface({ input: connection, crlfDelay: Infinity })
  // A connection reset, as by a client killed, fails its lines too; its close lets the client go.
  lines.on('error', () => {})
  lines.on('line', (line) => {
    let message: ClientMessage
    try {
      message = JSON.parse(line) as ClientMessage
    } catch {
      connection.destroy()
      return
    }
    if (!greeted) {
      if (message?.type !== 'hello' || message.protocol !== FLEET_PROTOCOL) {
        send({ type: 'error', id: 0, message: `fleet: the host speaks the fleet wire ${FLEET_PROTOCOL}, not ${String((message as { protocol?: unknown })?.protocol)}` })
        connection.end()
        return
      }
      greeted = true
      send({ type: 'hello', protocol: FLEET_PROTOCOL })
      return
    }
    if (message?.type === 'cancel') {
      inFlight.get(message.id)?.abort(new Error('cancelled'))
      return
    }
    if (message?.type !== 'request' || !Number.isSafeInteger(message.id) || typeof message.op !== 'string' || inFlight.has(message.id)) {
      connection.destroy()
      return
    }
    const { id, op, params } = message
    const controller = new AbortController()
    inFlight.set(id, controller)
    host.handle(op as Op, params as never, {
      client,
      signal: controller.signal,
      emit: (value) => { if (inFlight.has(id)) send({ type: 'event', id, value }) },
    }).then((value) => {
      if (inFlight.delete(id)) send({ type: 'result', id, value: value ?? null })
    }, (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code
      if (inFlight.delete(id)) send({ type: 'error', id, message: messageOf(error), ...typeof code === 'string' ? { code } : {} })
    })
  })
}

/** Take over a socket's path, unless a host answers on it. */
async function claim(socket: string): Promise<void> {
  const answering = await new Promise<boolean>((resolve) => {
    const probe = createConnection(socket)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => { resolve(false) })
  })
  if (answering) throw new Error(`fleet: another host serves ${socket}`)
  await unlink(socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}
