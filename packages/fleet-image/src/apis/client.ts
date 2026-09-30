/**
 * How an implementation calls a backend of the fleet host (fleet-tau's
 * backends.ts), for what it cannot do in the container, such as keeping
 * state or holding credentials: through fleet-box's service socket, which
 * every process in a session's container finds at $FLEET_SOCKET, one call
 * per connection and one JSON line each way: `{"service", "function",
 * "args"}` in, naming the backend and its method, and `{"result"}` or
 * `{"error": {"message"}}` back. Closing the connection before the answer
 * cancels the call, as the calling process ending does. What crosses is
 * JSON: an implementation turns other values, such as dates and bytes, into
 * JSON and back.
 * @module fleet-image/apis/client
 */

import { createConnection } from 'node:net'

/** Names fleet-box's service socket in a session's container. */
export const SOCKET_VARIABLE = 'FLEET_SOCKET'

/**
 * Call a method of a backend of the fleet host.
 * @param signal - cancels the call, closing its connection.
 * @returns the method's result, as the backend gives it.
 */
export function call(backend: string, method: string, args: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
  const where = `${backend}.${method}`
  const socketPath = process.env[SOCKET_VARIABLE]
  if (socketPath === undefined || socketPath === '') {
    return Promise.reject(new Error(`${where}: ${SOCKET_VARIABLE} is not set, so the fleet host cannot be reached`))
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    let settled = false
    const settle = (outcome: () => unknown): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      try {
        resolve(outcome())
      } catch (error) {
        reject(error)
      }
    }
    const onAbort = (): void => { settle(() => { throw signal?.reason }) }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Never half-closed while waiting: the socket takes that for the caller going away.
    socket.write(`${JSON.stringify({ service: backend, function: method, args })}\n`)
    socket.on('data', (chunk: Buffer) => {
      const end = chunk.indexOf(0x0a)
      if (end === -1) {
        chunks.push(chunk)
        return
      }
      chunks.push(chunk.subarray(0, end))
      settle(() => answer(Buffer.concat(chunks).toString('utf8'), where))
    })
    socket.on('error', (error) => { settle(() => { throw new Error(`${where}: cannot reach the fleet host at ${socketPath}: ${error.message}`) }) })
    socket.on('close', () => { settle(() => { throw new Error(`${where}: the fleet host closed the connection without an answer`) }) })
  })
}

function answer(line: string, where: string): unknown {
  let response: { result?: unknown; error?: { message?: unknown } }
  try {
    response = JSON.parse(line) as typeof response
  } catch {
    throw new Error(`${where}: the fleet host answered with something that is not JSON`)
  }
  if (typeof response === 'object' && response !== null && Object.hasOwn(response, 'result')) return response.result
  const reason = response?.error?.message
  throw new Error(typeof reason === 'string' ? reason : `${where}: the fleet host answered with neither a result nor an error`)
}
