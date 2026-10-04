/**
 * fleet's client runtime, which an extension's client imports in the box, as
 * `fleet-image/ext/client`, to call its server on the host
 * (docs/fleet-core/ext/index.md): through the helper's call socket, which
 * every process the helper starts finds at $FLEET_SOCKET
 * (../helper/cmd/calls.ts). What crosses is JSON: a client turns other
 * values, such as dates and bytes, into JSON and back, as the API it
 * implements declares them.
 * @module fleet-image/ext/client
 */

import { createConnection } from 'node:net'
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
