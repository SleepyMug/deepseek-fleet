/**
 * The client's end of the tau service's socket (fleet-protocol/tau): one
 * request per connection, with what follows it, and its answer, with what
 * follows that.
 * @module fleet-client/connection
 */

import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
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

/** An answer, and what follows it on the connection, read once. */
export interface Reply {
  response: Response
  /** What the service sends after its answer, such as a `finish`'s result; reading it to its end closes the connection. */
  body: AsyncIterable<Uint8Array>
  /** Close the connection, whatever is not read of the body. */
  close(): void
}

/**
 * Send one request to the service, and `upload` after it, if given, which
 * the client then ends, and read its answer.
 * @param socket - the service's socket.
 * @throws {@link NoService} or {@link ConnectionLost}, when the service gives no answer.
 */
export function exchange(socket: string, body: Body, upload?: AsyncIterable<Uint8Array>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket)
    let connected = false
    let settled = false
    let received = Buffer.alloc(0)
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      // Paused before it loses its reader, so that no data is dropped until a pipe reads it.
      connection.pause()
      connection.off('data', read)
      connection.off('end', lost)
      connection.off('close', lost)
      outcome()
    }
    const lost = (): void => {
      settle(() => {
        connection.destroy()
        reject(new ConnectionLost(`fleet: the tau service at ${socket} went away before it answered`))
      })
    }
    const read = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf(0x0a)
      if (end === -1) return
      const line = received.subarray(0, end).toString('utf8')
      settle(() => {
        let response: Response
        try {
          response = JSON.parse(line) as Response
        } catch {
          connection.destroy()
          reject(new Error(`fleet: the tau service answered with something else than JSON: ${line}`))
          return
        }
        const rest = new PassThrough()
        rest.write(received.subarray(end + 1))
        connection.pipe(rest)
        resolve({ response, body: rest, close: () => { connection.destroy() } })
      })
    }
    connection.once('connect', () => {
      connected = true
      connection.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, ...body })}\n`)
      if (upload !== undefined) void send(connection, upload)
    })
    connection.on('data', read)
    connection.once('error', (error: NodeJS.ErrnoException) => {
      if (connected) {
        lost()
        return
      }
      settle(() => {
        connection.destroy()
        reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new NoService(`fleet: no tau service at ${socket}; start the fleet host with \`dsh --profile fleet\``, { cause: error })
          : error)
      })
    })
    connection.once('end', lost)
    connection.once('close', lost)
  })
}

/** Send what follows a request, and end it; one that cannot be read cuts the connection, which the service then refuses. */
async function send(connection: Socket, upload: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const chunk of upload) {
      if (connection.destroyed) return
      if (!connection.write(chunk)) await once(connection, 'drain')
    }
    connection.end()
  } catch (error) {
    connection.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Send one request to the service, and `upload` after it, if given, and read its answer.
 * @throws what {@link exchange} does.
 */
export async function request(socket: string, body: Body, upload?: AsyncIterable<Uint8Array>): Promise<Response> {
  const { response, close } = await exchange(socket, body, upload)
  close()
  return response
}

/**
 * Send one request to the service, and `upload` after it, if given, and
 * give back what it answers with.
 * @throws what {@link exchange} does, and the service's error.
 */
export async function ask<O extends Body['op']>(socket: string, body: Body & { op: O }, upload?: AsyncIterable<Uint8Array>): Promise<Answers[O]> {
  const response = await request(socket, body, upload)
  if (!response.ok) throw new Error(response.error)
  return response.value as Answers[O]
}

/**
 * Send one request to the service, and give back what it answers with, and
 * what it sends after, read once.
 * @throws what {@link exchange} does, and the service's error.
 */
export async function receive<O extends Body['op']>(socket: string, body: Body & { op: O }): Promise<{ value: Answers[O]; body: AsyncIterable<Uint8Array> }> {
  const { response, body: rest, close } = await exchange(socket, body)
  if (!response.ok) {
    close()
    throw new Error(response.error)
  }
  return { value: response.value as Answers[O], body: rest }
}
