/**
 * The fleet host's control socket, `$DSH_HOME/fleet/control.sock`, which the
 * `fleet` command talks to. Only the owner can open it, and that is its
 * authentication, as the dsh home's own files are. One fleet host serves a
 * dsh home: a second one finds the socket answering and does not start.
 * @module fleet-core/control/server
 */

import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION, lineReader, requestSchema, socketPath } from 'fleet-protocol/control'
import type { Frame, Request } from 'fleet-protocol/control'
import { z } from 'zod'
import { ControlError, FleetControl, message } from './control.ts'

export const name = 'fleet-control'
export const inject = ['sessionController', 'workspaceRegistry', 'agents', 'sessions', 'sessionPersistence', 'fleetBox', 'fleetTau', 'fleetBackends']

export async function apply(ctx: Context): Promise<void> {
  const path = socketPath(resolveDshHome())
  const control = new FleetControl(ctx)
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    serve(ctx, control, socket)
  })
  server.on('error', (error) => { ctx.logger.warn(`fleet-control: ${path}: ${error.message}`) })
  await claim(path)
  await listen(server, path)
  try {
    // The folder is the owner's alone already; the socket's own mode keeps it so should the folder's be loosened.
    await chmod(path, 0o600)
    ctx.effect(() => () => close(server, sockets), 'fleet-control socket')
  } catch (error) {
    // Unloaded while it started, or the socket is not the owner's alone, so nothing else would close it.
    await close(server, sockets)
    throw error
  }
}

/** Answer one connection's request. */
function serve(ctx: Context, control: FleetControl, socket: Socket): void {
  const abort = new AbortController()
  socket.once('close', () => { abort.abort(new Error('fleet-control: the client went away')) })
  // A client that went away mid-answer; its close aborts the work.
  socket.on('error', () => {})
  let requested = false
  const read = lineReader((line) => {
    if (requested) return
    requested = true
    void answer(ctx, control, line, socket, abort.signal)
  }, MAX_REQUEST_BYTES)
  // Keep reading after the request, so a client leaving is noticed.
  socket.on('data', (chunk: Buffer) => {
    if (requested) return
    try {
      read(chunk)
    } catch (error) {
      requested = true
      write(socket, { type: 'error', code: 'fleet/bad-request', message: message(error) })
      socket.end()
    }
  })
}

async function answer(ctx: Context, control: FleetControl, line: string, socket: Socket, signal: AbortSignal): Promise<void> {
  try {
    const request = parse(line)
    const value = await dispatch(control, request, signal, (session) => { write(socket, { type: 'session', session }) })
    write(socket, { type: 'result', value })
  } catch (error) {
    if (signal.aborted) return
    const code = codeOf(error)
    if (code === undefined) ctx.logger.warn(error)
    write(socket, { type: 'error', code: code ?? 'fleet/internal', message: message(error) })
  } finally {
    socket.end()
  }
}

function dispatch(control: FleetControl, request: Request, signal: AbortSignal, started: (session: string) => void): unknown {
  switch (request.op) {
    case 'run': return control.run(request, signal, started)
    case 'wait': return control.wait(request, signal)
    case 'list': return control.list(signal)
    case 'cancel': return control.cancel(request)
    case 'stop': return control.stop(request, signal)
    case 'archive': return control.archive(request)
    case 'check': return control.check(request)
    case 'apis': return control.apis()
  }
}

function parse(line: string): Request {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new ControlError('fleet/bad-request', 'the request is not JSON')
  }
  const version = typeof value === 'object' && value !== null ? (value as { v?: unknown }).v : undefined
  if (version !== PROTOCOL_VERSION) {
    throw new ControlError('fleet/version', `this fleet host speaks protocol ${PROTOCOL_VERSION} and the request ${String(version)}; `
      + 'the fleet command (fleet-client) and the host (fleet-core) come from different versions of fleet')
  }
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) throw new ControlError('fleet/bad-request', z.prettifyError(parsed.error))
  return parsed.data
}

/** The protocol code of a failure: ours, or a dsh Remote failure's, which carries one. */
function codeOf(error: unknown): string | undefined {
  if (error instanceof ControlError) return error.code
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && code.includes('/') ? code : undefined
}

function write(socket: Socket, frame: Frame): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`)
}

/**
 * Make the socket's folder the owner's alone, and take over its path, unless
 * another process serves it. Two hosts starting at the same moment could
 * both find it free; the later one's socket then wins.
 */
async function claim(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  if (await answers(path)) {
    throw new Error(`fleet-control: another dsh process serves ${path}; one fleet host runs per dsh home`)
  }
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => { resolve(false) })
  })
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/**
 * Stop serving. Closing the server removes the socket file itself; removing
 * it again by path could remove a successor's.
 */
async function close(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}
