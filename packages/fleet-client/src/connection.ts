/**
 * The client's end of the tau service's socket (fleet-protocol/tau): one
 * request per connection, and its answer.
 * @module fleet-client/connection
 */

import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROTOCOL_VERSION, socketPath, type Answers, type Request, type Response } from 'fleet-protocol/tau'

/** A request without its protocol version, which {@link request} adds. */
export type Body = WithoutProtocol<Request>

/** Each op's request without its protocol version. */
type WithoutProtocol<R> = R extends unknown ? Omit<R, 'protocol'> : never

/** No service listens on the socket. */
export class NoService extends Error {}

/** The service went away before it answered, as when dsh stops. */
export class ConnectionLost extends Error {}

/**
 * The service's socket in the dsh home, as dsh finds the home: `$DSH_HOME`
 * unless it is blank, with a leading `~` for the user's home, or else ~/.dsh.
 */
export function defaultSocket(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME ?? ''
  if (configured.trim() === '') return socketPath(join(homedir(), '.dsh'))
  const expanded = configured === '~' || configured.startsWith('~/') ? homedir() + configured.slice(1) : configured
  return socketPath(resolve(expanded))
}

/**
 * Send one request to the service and read its answer.
 * @param socket - the service's socket.
 * @throws {@link NoService} or {@link ConnectionLost}, when the service gives no answer.
 */
export function request(socket: string, body: Body): Promise<Response> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket)
    let connected = false
    let settled = false
    let received = ''
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      connection.destroy()
      outcome()
    }
    const lost = (): void => {
      settle(() => { reject(new ConnectionLost(`fleet: the tau service at ${socket} went away before it answered`)) })
    }
    connection.setEncoding('utf8')
    connection.once('connect', () => {
      connected = true
      connection.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, ...body })}\n`)
    })
    connection.on('data', (chunk: string) => { received += chunk })
    connection.once('error', (error: NodeJS.ErrnoException) => {
      if (connected) {
        lost()
        return
      }
      settle(() => {
        reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new NoService(`fleet: no tau service at ${socket}; start the fleet host with \`dsh --profile fleet\``, { cause: error })
          : error)
      })
    })
    connection.once('end', () => {
      const line = received.split('\n', 1)[0]
      if (line === '') {
        lost()
        return
      }
      settle(() => {
        try {
          resolve(JSON.parse(line) as Response)
        } catch {
          reject(new Error(`fleet: the tau service answered with something else than JSON: ${line}`))
        }
      })
    })
    connection.once('close', lost)
  })
}

/**
 * Send one request to the service, and give back what it answers with.
 * @throws what {@link request} does, and the service's error.
 */
export async function ask<O extends Body['op']>(socket: string, body: Body & { op: O }): Promise<Answers[O]> {
  const response = await request(socket, body)
  if (!response.ok) throw new Error(response.error)
  return response.value as Answers[O]
}
