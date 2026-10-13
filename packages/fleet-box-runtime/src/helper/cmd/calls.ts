/**
 * The call socket: how an extension's client in the box (../../ext/client.ts)
 * calls its server on the host. The helper listens at $FLEET_SOCKET, by
 * default {@link CALL_SOCKET}, and sets the variable for every process it
 * starts. Each connection carries one call, a JSON line
 * `{"contract", "method", "args"}`, which the helper sends the host as a `call`;
 * it writes the host's answer back as one line, `{"result": …}` or
 * `{"error": {"message": …}}`, and closes. A call with `"body": true` is
 * followed by bytes, up to the end of what the client sends, which the
 * helper sends the host as they come; an answer with `"body": true` is
 * followed by bytes, up to the end of the connection, which the helper
 * writes as the host sends them, and a connection cut short says the host
 * could not send them all. A connection that closes first cancels its call. Which session the call is for, whether it may make it,
 * and whether its arguments fit is the host's to decide; the helper checks
 * only the call's shape.
 * @module @sleepymug/fleet-box-runtime/helper/cmd/calls
 */

import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { CALL_SOCKET, SOCKET_VARIABLE } from '../../layout.ts'
import type { Call, HelperMessage, HostMessage } from '../protocol.ts'

type Answer = Extract<HostMessage, { type: 'call-result' | 'call-error' | 'call-data' | 'call-end' }>

export class CallSocket {
  /** Calls sent to the host and not answered yet, by id. */
  private readonly calls = new Map<number, Socket>()
  private nextId = 1

  private constructor(private readonly server: Server, private readonly send: (message: HelperMessage) => void) {}

  /**
   * Listen at $FLEET_SOCKET, or {@link CALL_SOCKET}, which then becomes
   * $FLEET_SOCKET, for the processes the helper starts.
   * @param send - sends a message to the host.
   * @param env - the helper's environment, which the processes it starts start from.
   */
  static async listen(send: (message: HelperMessage) => void, env: Record<string, string | undefined>): Promise<CallSocket> {
    const path = env[SOCKET_VARIABLE] || CALL_SOCKET
    await mkdir(dirname(path), { recursive: true })
    // One left by a helper before this one, which was ended with the box's last start.
    await rm(path, { force: true })
    let socket: CallSocket | undefined
    // A client that sends bytes after its call ends them, and then reads the answer.
    const server = createServer({ allowHalfOpen: true }, (connection) => { socket?.accept(connection) })
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
    env[SOCKET_VARIABLE] = path
    return socket
  }

  /** Write the host's answer to its caller, and the bytes after it; one whose caller has gone is dropped. */
  answer(message: Answer): void {
    const connection = this.calls.get(message.id)
    if (connection === undefined) return
    switch (message.type) {
      case 'call-error':
        this.calls.delete(message.id)
        connection.end(`${JSON.stringify({ error: { message: message.message } })}\n`)
        return
      case 'call-result': {
        const reply = message.body === true ? { result: message.value, body: true } : { result: message.value }
        if (message.body === true) {
          connection.write(`${JSON.stringify(reply)}\n`)
          return
        }
        this.calls.delete(message.id)
        connection.end(`${JSON.stringify(reply)}\n`)
        return
      }
      case 'call-data':
        connection.write(Buffer.from(message.data, 'base64'))
        return
      case 'call-end':
        this.calls.delete(message.id)
        if (message.error === undefined) connection.end()
        else connection.destroy()
    }
  }

  /** Stop listening, and drop the calls not answered. */
  close(): Promise<void> {
    for (const connection of this.calls.values()) connection.destroy()
    this.calls.clear()
    return new Promise((resolve) => { this.server.close(() => { resolve() }) })
  }

  private accept(connection: Socket): void {
    let received = Buffer.alloc(0)
    let id: number | undefined
    let sending = false
    connection.on('error', () => {})
    connection.on('data', (chunk: Buffer) => {
      if (id !== undefined) {
        if (sending) this.send({ type: 'call-data', id, data: chunk.toString('base64') })
        return
      }
      received = Buffer.concat([received, chunk])
      const end = received.indexOf(0x0a)
      if (end < 0) return
      const call = parse(received.subarray(0, end).toString('utf8'))
      if (call === undefined) {
        connection.end(`${JSON.stringify({ error: { message: 'fleet: a call is one line of JSON, {"contract", "method", "args", "body"?}, args a list' } })}\n`)
        return
      }
      id = this.nextId++
      this.calls.set(id, connection)
      this.send({ type: 'call', id, ...call })
      sending = call.body === true
      const rest = received.subarray(end + 1)
      if (sending && rest.length > 0) this.send({ type: 'call-data', id, data: rest.toString('base64') })
    })
    connection.once('end', () => {
      // The end of a call's bytes; or, of a call without any, its caller gone, whose call the close cancels.
      if (sending && id !== undefined && this.calls.has(id)) this.send({ type: 'call-end', id })
      else connection.destroy()
      sending = false
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
  const { contract, method, args, body } = value as Record<string, unknown>
  if (typeof contract !== 'string' || typeof method !== 'string' || !Array.isArray(args) || (body !== undefined && body !== true)) return undefined
  return body === true ? { contract, method, args, body } : { contract, method, args }
}
