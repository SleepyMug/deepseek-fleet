/**
 * The call socket: how an extension's client in the box (../../ext/client.ts)
 * calls its server on the host. The helper listens at $FLEET_SOCKET, by
 * default {@link CALL_SOCKET}, and sets the variable for every process it
 * starts. Each connection carries one call, a JSON line
 * `{"api", "method", "args"}`, which the helper sends the host as a `call`;
 * it writes the host's answer back as one line, `{"result": …}` or
 * `{"error": {"message": …}}`, and closes. A connection that closes first
 * cancels its call. Which session the call is for, whether it may make it,
 * and whether its arguments fit is the host's to decide; the helper checks
 * only the call's shape.
 * @module fleet-image/helper/cmd/calls
 */

import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { CALL_SOCKET, SOCKET_VARIABLE } from '../../layout.ts'
import type { Call, HelperMessage, HostMessage } from '../protocol.ts'

type Answer = Extract<HostMessage, { type: 'call-result' | 'call-error' }>

export class CallSocket {
  /** Calls sent to the host and not answered yet, by id. */
  private readonly calls = new Map<number, Socket>()
  private nextId = 1

  private constructor(private readonly server: Server, private readonly send: (message: HelperMessage) => void) {}

  /**
   * Listen at $FLEET_SOCKET, or {@link CALL_SOCKET}, which then becomes
   * $FLEET_SOCKET, for the processes the helper starts.
   * @param send - sends a message to the host.
   */
  static async listen(send: (message: HelperMessage) => void): Promise<CallSocket> {
    const path = process.env[SOCKET_VARIABLE] || CALL_SOCKET
    await mkdir(dirname(path), { recursive: true })
    // One left by a helper before this one, which was ended with the box's last start.
    await rm(path, { force: true })
    let socket: CallSocket | undefined
    const server = createServer((connection) => { socket?.accept(connection) })
    socket = new CallSocket(server, send)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // Whoever runs in the box may call; the box is the session's.
    await chmod(path, 0o666)
    process.env[SOCKET_VARIABLE] = path
    return socket
  }

  /** Write the host's answer to its caller; one whose caller has gone is dropped. */
  answer(message: Answer): void {
    const connection = this.calls.get(message.id)
    if (connection === undefined) return
    this.calls.delete(message.id)
    const reply = message.type === 'call-result' ? { result: message.value } : { error: { message: message.message } }
    connection.end(`${JSON.stringify(reply)}\n`)
  }

  /** Stop listening, and drop the calls not answered. */
  close(): Promise<void> {
    for (const connection of this.calls.values()) connection.destroy()
    this.calls.clear()
    return new Promise((resolve) => { this.server.close(() => { resolve() }) })
  }

  private accept(connection: Socket): void {
    let text = ''
    let id: number | undefined
    connection.setEncoding('utf8')
    connection.on('error', () => {})
    connection.on('data', (chunk: string) => {
      if (id !== undefined) return
      text += chunk
      const end = text.indexOf('\n')
      if (end < 0) return
      const call = parse(text.slice(0, end))
      if (call === undefined) {
        connection.end(`${JSON.stringify({ error: { message: 'fleet: a call is one line of JSON, {"api", "method", "args"}, args a list' } })}\n`)
        return
      }
      id = this.nextId++
      this.calls.set(id, connection)
      this.send({ type: 'call', id, ...call })
    })
    connection.once('close', () => {
      if (id === undefined || !this.calls.delete(id)) return
      this.send({ type: 'call-cancel', id })
    })
  }
}

function parse(line: string): Call | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { api, method, args } = value as Record<string, unknown>
  if (typeof api !== 'string' || typeof method !== 'string' || !Array.isArray(args)) return undefined
  return { api, method, args }
}
