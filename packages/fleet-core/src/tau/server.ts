/**
 * The tau service's socket (fleet-protocol/tau): it reads one request from
 * each connection, has the service carry it out, answers, and ends the
 * connection. Only the owner can open the socket, which is its
 * authentication, as the dsh home's own files are. One service serves a
 * socket: another finds it answering and does not start.
 * @module fleet-core/tau/server
 */

import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import { PROTOCOL_VERSION, type Request, type Response } from 'fleet-protocol/tau'
import type { TauService } from './service.ts'

/** What the server asks of the service. */
export type Operations = Pick<TauService, 'create' | 'start' | 'stop' | 'delete'>

/**
 * Serve the service on a socket.
 * @param path - the socket's path; its folder is made if missing.
 * @returns what closes the socket and its connections.
 */
export async function listen(path: string, service: Operations): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await claim(path)
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    serve(socket, service)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const close = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    for (const socket of sockets) socket.destroy()
    await closed
  }
  try {
    await chmod(path, 0o600)
  } catch (error) {
    await close()
    throw error
  }
  return close
}

/** Take over a socket's path, unless a service answers on it. */
async function claim(path: string): Promise<void> {
  const answering = await new Promise<boolean>((resolve) => {
    const probe = createConnection(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => { resolve(false) })
  })
  if (answering) throw new Error(`fleet: another tau service serves ${path}`)
  // What is left of a service that did not close it.
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
}

/** Read one connection's request, up to its first newline, and answer it. */
function serve(socket: Socket, service: Operations): void {
  let received = ''
  let answered = false
  socket.setEncoding('utf8')
  // A client that went away before its answer.
  socket.on('error', () => {})
  socket.on('data', (chunk: string) => {
    if (answered) return
    received += chunk
    const end = received.indexOf('\n')
    if (end === -1) return
    answered = true
    void answer(service, received.slice(0, end)).then((response) => {
      socket.end(`${JSON.stringify(response)}\n`)
    })
  })
}

async function answer(service: Operations, line: string): Promise<Response> {
  try {
    const request = parse(line)
    switch (request.op) {
      case 'create':
        return { ok: true, value: await service.create(request.tauDir, request.values, request.callerCwd) }
      case 'start':
      case 'stop':
      case 'delete':
        await service[request.op](request.sessionId)
        return { ok: true, value: null }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** A request, with the fields its op needs; tau's library checks the values. */
function parse(line: string): Request {
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    throw new Error('fleet: the request is not JSON')
  }
  if (!isRecord(request)) throw new Error('fleet: the request is not a JSON object')
  if (request.protocol !== PROTOCOL_VERSION) {
    throw new Error(`fleet: the client speaks protocol ${String(request.protocol)}, and the tau service ${String(PROTOCOL_VERSION)}`)
  }
  switch (request.op) {
    case 'create':
      for (const field of ['tauDir', 'callerCwd'] as const) {
        const path = request[field]
        if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`fleet: create takes ${field}, an absolute path`)
      }
      return request as Request
    case 'start':
    case 'stop':
    case 'delete':
      if (typeof request.sessionId !== 'string') throw new Error(`fleet: ${request.op} takes a sessionId`)
      return request as Request
    default:
      throw new Error(`fleet: no op ${String(request.op)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
