/**
 * Where calls go: an HTTP/2 connection, as connect-node's transports take
 * one, which a proxy carries calls through too. Either one dialed to a
 * socket, and dialed again as each call needs it once the last is lost, or
 * one fixed, such as a tunnel's, which never comes back once closed.
 * @module @sleepymug/fleet-net/upstream
 */

import { connect } from 'node:net'
import type { ClientHttp2Session, ClientHttp2Stream, ClientSessionRequestOptions, OutgoingHttpHeaders } from 'node:http2'
import { Code, ConnectError } from '@connectrpc/connect'
import { Http2SessionManager } from '@connectrpc/connect-node'

/** The authority every call names, since a socket names its server. */
export const AUTHORITY = 'fleet'

/** An HTTP/2 connection calls go through, as connect-node's transports take one. */
export interface Upstream {
  /** The origin its calls name, `http://fleet`, as a transport's base URL must have it. */
  readonly authority: string
  request(method: string, path: string, headers: OutgoingHttpHeaders, options: Omit<ClientSessionRequestOptions, 'signal'>): Promise<ClientHttp2Stream>
  notifyResponseByteRead(stream: ClientHttp2Stream): void
}

/** An upstream dialed to a socket. */
export interface Dialed extends Upstream {
  /** End the connection, failing what goes through it, and dial no more. */
  close(): void
}

/**
 * An HTTP/2 connection to the socket at `path`, dialed once a call needs
 * it, and again after it is lost, as after its server restarts. An idle
 * one keeps no process alive.
 */
export function dial(path: string): Dialed {
  const manager = new Http2SessionManager(`http://${AUTHORITY}`, {}, { createConnection: () => connect(path) })
  return {
    authority: manager.authority,
    request: (method, at, headers, options) => manager.request(method, at, headers, options),
    notifyResponseByteRead: (stream) => { manager.notifyResponseByteRead(stream) },
    close: () => { manager.abort() },
  }
}

/** Calls through one HTTP/2 connection already made, such as a tunnel's; once it is closed, calls fail as unavailable. */
export function sessionUpstream(session: ClientHttp2Session): Upstream {
  return {
    authority: `http://${AUTHORITY}`,
    request: async (method, path, headers, options) => {
      if (session.closed || session.destroyed) throw new ConnectError('the connection is closed', Code.Unavailable)
      return session.request({ ...headers, ':method': method, ':path': path }, options)
    },
    notifyResponseByteRead: () => {},
  }
}
