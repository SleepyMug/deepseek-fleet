/**
 * The tau service's socket (fleet-protocol/tau): it reads one request from
 * each connection, and for a `start` the call that follows it, up to the end
 * of what the client sends; has the service carry it out; answers, and
 * after a `finish`'s answer sends the result; and ends the connection. A
 * client that goes away first gives up its wait, such as a `finish`'s, and
 * nothing else. Its clients are the host's, which reach every run. Only the
 * owner can open the socket, which is its authentication, as the dsh home's
 * own files are. One service serves a socket: another finds it answering
 * and does not start.
 * @module fleet-core/tau/server
 */

import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PROTOCOL_VERSION, type Request, type Response } from 'fleet-protocol/tau'
import { HOST } from './runs.ts'
import type { TauService } from './service.ts'

/** What the server asks of the service. */
export type Operations = Pick<TauService, 'start' | 'list' | 'status' | 'finish' | 'cancel' | 'delete'>

/**
 * Serve the service on a socket.
 * @param path - the socket's path; its folder is made if missing.
 * @returns what closes the socket and its connections.
 */
export async function listen(path: string, service: Operations): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await claim(path)
  const sockets = new Set<Socket>()
  // A client ends what it sends with a `start`'s call, and reads the answer after.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
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

/**
 * Read one connection's request, up to its first newline, and answer it;
 * what follows the newline is the request's body, a `start`'s call.
 */
function serve(socket: Socket, service: Operations): void {
  let received = Buffer.alloc(0)
  let op: unknown
  const gone = new AbortController()
  const leave = (): void => { gone.abort(new Error('fleet: the client went away')) }
  socket.once('close', leave)
  // A client that ends what it sends ends a start's call, and with any other request goes away.
  socket.once('end', () => { if (op !== 'start') leave() })
  // A client that went away before its answer.
  socket.on('error', () => {})
  const read = (chunk: Buffer): void => {
    received = Buffer.concat([received, chunk])
    const end = received.indexOf(0x0a)
    if (end === -1) return
    // Paused before it loses its reader, so that no data is dropped until a pipe reads it.
    socket.pause()
    socket.off('data', read)
    const line = received.subarray(0, end).toString('utf8')
    try {
      op = (JSON.parse(line) as { op?: unknown }).op
    } catch {}
    const body = new PassThrough()
    body.write(received.subarray(end + 1))
    socket.pipe(body)
    void respond(socket, service, line, body, gone.signal)
  }
  socket.on('data', read)
}

async function respond(socket: Socket, service: Operations, line: string, body: Readable, signal: AbortSignal): Promise<void> {
  const { response, archive } = await answer(service, line, body, signal)
  // What the client sends that the service did not read, read to its end, so that the client reads the answer.
  body.resume()
  socket.write(`${JSON.stringify(response)}\n`)
  if (archive === undefined) {
    socket.end()
    return
  }
  await pipeline(archive, socket).catch(() => { socket.destroy() })
}

async function answer(service: Operations, line: string, body: Readable, signal: AbortSignal): Promise<{ response: Response; archive?: AsyncIterable<Uint8Array> }> {
  try {
    const request = parse(line)
    switch (request.op) {
      case 'start':
        return { response: { ok: true, value: await service.start(HOST, { title: request.title, project: request.project, targets: request.targets }, body) } }
      case 'list':
        return { response: { ok: true, value: await service.list(HOST) } }
      case 'status':
        return { response: { ok: true, value: await service.status(HOST, request.sessionId) } }
      case 'finish': {
        const { result, targets, archive } = await service.finish(HOST, request.sessionId, signal)
        return { response: { ok: true, value: { result, targets } }, archive }
      }
      case 'cancel':
      case 'delete':
        await service[request.op](HOST, request.sessionId)
        return { response: { ok: true, value: null } }
    }
  } catch (error) {
    return { response: { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
}

/** A request, with the fields its op needs; tau's library checks a start's call. */
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
    case 'start':
      if (typeof request.title !== 'string' || request.title.trim() === '') throw new Error('fleet: start takes a title')
      if (typeof request.project !== 'string' || !isAbsolute(request.project)) throw new Error('fleet: start takes project, an absolute path')
      if (!isRecord(request.targets) || !Object.values(request.targets).every(path => typeof path === 'string' && isAbsolute(path))) {
        throw new Error('fleet: start takes targets, each an absolute path')
      }
      return request as Request
    case 'list':
      return request as Request
    case 'status':
    case 'finish':
    case 'cancel':
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
