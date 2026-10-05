/**
 * fleet's client runtime, which an extension's client imports in the box, as
 * `fleet-image/ext/client`, to call its server on the host
 * (docs/fleet-core/ext/index.md): through the helper's call socket, which
 * every process the helper starts finds at $FLEET_SOCKET
 * (../helper/cmd/calls.ts). What crosses is JSON: a client turns other
 * values, such as dates, into JSON and back, as the API it implements
 * declares them; bytes, such as an archive, go after the call, and come
 * after its answer, with {@link callStream}.
 * @module fleet-image/ext/client
 */

import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { SOCKET_VARIABLE } from '../layout.ts'

/**
 * Call a method of the server of the extension that implements an API.
 * @param api - the API's name, which its extension is provided under.
 * @param args - JSON; an `undefined` at the end is left out, as an optional argument not given.
 * @param signal - cancels the call, which closes its connection, and the server's signal aborts.
 * @returns the method's result, as the server gives it; a failure there rejects with its message.
 */
export function call(api: string, method: string, args: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
  const where = `${api}.${method}`
  const path = process.env[SOCKET_VARIABLE]
  if (path === undefined || path === '') return Promise.reject(new Error(`${where}: ${SOCKET_VARIABLE} is not set, so the fleet host cannot be reached`))
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  const given = [...args]
  while (given.length > 0 && given.at(-1) === undefined) given.pop()
  let line: string
  try {
    line = `${JSON.stringify({ api, method, args: given })}\n`
  } catch (error) {
    return Promise.reject(new TypeError(`${where}: its arguments are not JSON`, { cause: error }))
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let text = ''
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      outcome()
    }
    const abort = (): void => { settle(() => { reject(signal?.reason) }) }
    signal?.addEventListener('abort', abort, { once: true })
    socket.setEncoding('utf8')
    socket.on('connect', () => { socket.write(line) })
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('error', (error) => { settle(() => { reject(new Error(`${where}: the fleet host could not be reached: ${error.message}`, { cause: error })) }) })
    socket.on('end', () => {
      settle(() => {
        let reply: { result?: unknown; error?: { message?: unknown } }
        try {
          reply = JSON.parse(text) as typeof reply
        } catch {
          reject(new Error(`${where}: the fleet host's answer is not JSON`))
          return
        }
        if (reply.error !== undefined) reject(new Error(`${where}: ${String(reply.error.message)}`))
        else resolve(reply.result ?? null)
      })
    })
  })
}

/**
 * Call a method of an extension's server with bytes after the call, if
 * given, such as an archive, and give back its result and the bytes it
 * sends after it, if it sends any, read once; bytes cut short end early.
 * @param args - JSON, as {@link call} takes them.
 * @param options.body - the bytes after the call; reading them stops if the call is cancelled.
 * @param options.signal - cancels the call, which closes its connection, and the server's signal aborts.
 */
export function callStream(
  api: string,
  method: string,
  args: readonly unknown[],
  options: { body?: AsyncIterable<Uint8Array>; signal?: AbortSignal } = {},
): Promise<{ value: unknown; body: AsyncIterable<Uint8Array> }> {
  const where = `${api}.${method}`
  const { body, signal } = options
  const path = process.env[SOCKET_VARIABLE]
  if (path === undefined || path === '') return Promise.reject(new Error(`${where}: ${SOCKET_VARIABLE} is not set, so the fleet host cannot be reached`))
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  const given = [...args]
  while (given.length > 0 && given.at(-1) === undefined) given.pop()
  let line: string
  try {
    line = `${JSON.stringify({ api, method, args: given, ...body === undefined ? {} : { body: true } })}\n`
  } catch (error) {
    return Promise.reject(new TypeError(`${where}: its arguments are not JSON`, { cause: error }))
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let received = Buffer.alloc(0)
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      socket.pause()
      socket.off('data', read)
      outcome()
    }
    const abort = (): void => {
      socket.destroy()
      settle(() => { reject(signal?.reason) })
    }
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('close', () => { signal?.removeEventListener('abort', abort) })
    const read = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf(0x0a)
      if (end === -1) return
      settle(() => {
        let reply: { result?: unknown; body?: unknown; error?: { message?: unknown } }
        try {
          reply = JSON.parse(received.subarray(0, end).toString('utf8')) as typeof reply
        } catch {
          socket.destroy()
          reject(new Error(`${where}: the fleet host's answer is not JSON`))
          return
        }
        if (reply.error !== undefined) {
          socket.destroy()
          reject(new Error(`${where}: ${String(reply.error.message)}`))
          return
        }
        const rest = new PassThrough()
        if (reply.body === true) {
          rest.write(received.subarray(end + 1))
          // A connection cut short ends the bytes short, which their reader finds.
          socket.on('error', () => { rest.end() })
          socket.pipe(rest)
        } else {
          rest.end()
          socket.destroy()
        }
        resolve({ value: reply.result ?? null, body: rest })
      })
    }
    socket.on('data', read)
    socket.on('error', (error) => { settle(() => { reject(new Error(`${where}: the fleet host could not be reached: ${error.message}`, { cause: error })) }) })
    socket.once('end', () => { settle(() => { reject(new Error(`${where}: the fleet host did not answer`)) }) })
    socket.on('connect', () => {
      socket.write(line)
      if (body !== undefined) void send(socket, body)
    })
  })
}

/** Send the bytes after a call, and end them; bytes that cannot be read cut the connection. */
async function send(socket: Socket, body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const chunk of body) {
      if (socket.destroyed) return
      if (!socket.write(chunk)) await once(socket, 'drain')
    }
    socket.end()
  } catch (error) {
    socket.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}
