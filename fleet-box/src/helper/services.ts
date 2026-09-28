/**
 * The container's service socket, {@link SERVICE_SOCKET}: tau's service
 * protocol (@sleepymug/tau's SPEC.md) for programs in the container, relayed
 * to the host. Each connection carries one call, a JSON line naming a
 * service, a function and positional arguments; the helper forwards it to
 * the host as a `call` message and writes the host's answer back as one
 * line, `{"result":…}` or `{"error":{"message":…}}`, then closes. A connection
 * that closes before its answer cancels the call. Everything else is the
 * host's to decide: which session the call is for, whether its agent
 * declares it, and whether its arguments fit; the helper checks only the
 * call's shape and size.
 *
 * While the host has fallen behind reading the helper's messages, the socket
 * stops reading calls, as the processes' output does (./processes.ts).
 * @module fleet-box/helper/services
 */

import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { MAX_CALL_BYTES, SERVICE_SOCKET, type HostMessage } from './protocol.ts'
import type { Channel } from './processes.ts'

/** Connections served at once; more are closed as they arrive. */
const MAX_CONNECTIONS = 256

type Answer = Extract<HostMessage, { type: 'call-result' | 'call-error' }>

export class ServiceSocket {
  private readonly server: Server
  /** Calls forwarded to the host and not answered yet, by id. */
  private readonly calls = new Map<number, Socket>()
  /** Connections still reading their call, paused together while the host is behind. */
  private readonly reading = new Set<Socket>()
  private paused = false
  private nextCall = 1

  constructor(private readonly channel: Channel, private readonly path = SERVICE_SOCKET) {
    // tau's runtimes never half-close while they wait, so a program's end of the connection is its going away.
    this.server = createServer((socket) => { this.accept(socket) })
    this.server.maxConnections = MAX_CONNECTIONS
    channel.onDrain(() => {
      this.paused = false
      for (const socket of this.reading) socket.resume()
    })
  }

  /** Listen at the socket's path, replacing whatever a previous helper left there. */
  async listen(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await rm(this.path, { force: true })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.path, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    await chmod(this.path, 0o600)
  }

  /** Write the host's answer to a call, if its program still waits. */
  answer(message: Answer): void {
    const socket = this.calls.get(message.call)
    if (socket === undefined) return
    this.calls.delete(message.call)
    socket.end(`${JSON.stringify(message.type === 'call-result' ? { result: message.result } : { error: { message: message.message } })}\n`)
  }

  /** Stop serving: waiting programs see their connection close, which fails their call. */
  close(): void {
    this.server.close()
    for (const socket of [...this.calls.values(), ...this.reading]) socket.destroy()
    this.calls.clear()
    this.reading.clear()
  }

  private accept(socket: Socket): void {
    socket.on('error', () => {})
    this.reading.add(socket)
    if (this.paused) socket.pause()
    const parts: Buffer[] = []
    let size = 0
    let done = false
    const finish = (): void => {
      done = true
      this.reading.delete(socket)
    }
    socket.on('data', (chunk: Buffer) => {
      if (done) return
      const newline = chunk.indexOf(0x0a)
      const piece = newline === -1 ? chunk : chunk.subarray(0, newline)
      size += piece.length
      if (size > MAX_CALL_BYTES) {
        finish()
        refuse(socket, `the call is over the ${MAX_CALL_BYTES / (1024 * 1024)} MiB limit`)
        return
      }
      parts.push(piece)
      if (newline === -1) return
      finish()
      this.forward(socket, Buffer.concat(parts).toString('utf8'))
    })
    socket.on('end', () => {
      if (done) return
      finish()
      socket.destroy()
    })
    socket.once('close', () => {
      this.reading.delete(socket)
      for (const [id, waiting] of this.calls) {
        if (waiting !== socket) continue
        this.calls.delete(id)
        this.send({ type: 'call-cancel', call: id })
      }
    })
  }

  private forward(socket: Socket, line: string): void {
    let call: { service: string; function: string; args: unknown[] }
    try {
      call = parseCall(line)
    } catch (error) {
      refuse(socket, error instanceof Error ? error.message : String(error))
      return
    }
    const id = this.nextCall++
    this.calls.set(id, socket)
    try {
      this.send({ type: 'call', call: id, service: call.service, function: call.function, args: call.args })
    } catch (error) {
      this.calls.delete(id)
      refuse(socket, error instanceof Error ? error.message : String(error))
    }
  }

  /** Send a message to the host, pausing the reading of calls while it is behind. */
  private send(message: Parameters<Channel['send']>[0]): void {
    if (this.channel.send(message) || this.paused) return
    this.paused = true
    for (const socket of this.reading) socket.pause()
  }
}

/** A call line as tau's protocol has it: an object naming a service and a function, with an array of arguments. */
function parseCall(line: string): { service: string; function: string; args: unknown[] } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('the call is not a JSON line')
  }
  const call = value as { service?: unknown; function?: unknown; args?: unknown } | null
  if (typeof call !== 'object' || call === null || Array.isArray(call)) throw new Error('the call must be a JSON object')
  if (typeof call.service !== 'string' || typeof call.function !== 'string') throw new Error('the call must name its service and function as strings')
  if (!Array.isArray(call.args)) throw new Error('the call\'s args must be an array')
  return { service: call.service, function: call.function, args: call.args }
}

function refuse(socket: Socket, message: string): void {
  socket.end(`${JSON.stringify({ error: { message } })}\n`)
}
