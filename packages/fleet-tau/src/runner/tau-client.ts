/**
 * A tau service call from the runner (adapted from pi-run's provider.ts):
 * one connection to $TAU_SOCKET, one JSON line each way (@sleepymug/tau's
 * SPEC.md). Aborting closes the connection, which cancels the call. The
 * host checks the arguments and the result against the service's manifest,
 * so they cross here as they are.
 * @module fleet-tau/runner/tau-client
 */

import { createConnection } from 'node:net'

export function callService(socketPath: string, service: string, fn: string, args: readonly unknown[], signal: AbortSignal): Promise<unknown> {
  const where = `${service}.${fn}`
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    let settled = false
    const settle = (outcome: () => unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket.destroy()
      try {
        resolve(outcome())
      } catch (error) {
        reject(error)
      }
    }
    const onAbort = (): void => { settle(() => { throw signal.reason }) }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.write(`${JSON.stringify({ service, function: fn, args })}\n`)
    socket.on('data', (chunk: Buffer) => {
      const end = chunk.indexOf(0x0a)
      if (end === -1) {
        chunks.push(chunk)
        return
      }
      chunks.push(chunk.subarray(0, end))
      settle(() => parseResponse(Buffer.concat(chunks).toString('utf8'), where))
    })
    socket.on('error', (error) => { settle(() => { throw new Error(`${where}: cannot reach the service socket at ${socketPath}: ${error.message}`) }) })
    socket.on('close', () => { settle(() => { throw new Error(`${where}: the service socket closed the connection without an answer`) }) })
  })
}

function parseResponse(line: string, where: string): unknown {
  let response: { result?: unknown; error?: { message?: unknown } }
  try {
    response = JSON.parse(line) as typeof response
  } catch {
    throw new Error(`${where}: the service socket answered with something that is not JSON`)
  }
  if (typeof response === 'object' && response !== null && Object.hasOwn(response, 'result')) return response.result
  const reason = response?.error?.message
  throw new Error(typeof reason === 'string' ? reason : `${where}: the service socket answered with neither a result nor an error`)
}
