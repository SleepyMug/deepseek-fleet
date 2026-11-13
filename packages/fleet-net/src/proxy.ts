/**
 * Carrying a call through: a request that came in, HTTP/1.1 or HTTP/2, goes
 * on as an HTTP/2 stream of an upstream, at a path of the carrier's
 * choosing, with headers it adds, and the answer comes back as it is, its
 * headers, its body and its trailers, read as they come both ways, so each
 * side's flow control paces the other. The call is never decoded, so a
 * Connect, gRPC or gRPC-Web call is carried alike. A side that goes away
 * cancels the other's.
 * @module @sleepymug/fleet-net/proxy
 */

import type { ServerResponse } from 'node:http'
import { constants, Http2ServerResponse, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http2'
import { Code, ConnectError } from '@connectrpc/connect'
import type { Request, Response } from './listen.ts'
import { refuse } from './refuse.ts'
import type { Upstream } from './upstream.ts'

/** Headers that are a hop's own, or HTTP/2's pseudo-headers, which a carried call does not keep. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings', 'host'])

export interface Carry {
  /** Where the call goes on the upstream. */
  path: string
  /** Headers to add, or set in place of the caller's. */
  headers?: Readonly<Record<string, string>>
  /** Whether to drop one of the caller's headers, by its lowercase name, before `headers` are added. */
  drop?: (name: string) => boolean
}

/** Carry the call of `req` to `upstream`, and its answer back to `res`. */
export function forward(req: Request, response: Response, upstream: Upstream, carry: Carry): void {
  // Both Node's responses take what is written here alike.
  const res = response as ServerResponse
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers as IncomingHttpHeaders)) {
    if (name.startsWith(':') || HOP_BY_HOP.has(name) || value === undefined) continue
    // HTTP/2 allows `te: trailers` alone, which gRPC asks.
    if (name === 'te' && value !== 'trailers') continue
    if (carry.drop?.(name) === true) continue
    headers[name] = value
  }
  Object.assign(headers, carry.headers)
  let settled = false
  const fail = (error: unknown): void => {
    if (settled) return
    settled = true
    if (!res.headersSent) refuse(req, response, ConnectError.from(error, Code.Unavailable))
    else res.destroy()
  }
  upstream.request(req.method ?? 'POST', carry.path, headers, {}).then((stream) => {
    // The caller gone before the answer's end, the call is cancelled upstream.
    res.once('close', () => {
      if (settled) return
      settled = true
      stream.close(constants.NGHTTP2_CANCEL)
    })
    req.on('error', () => { stream.close(constants.NGHTTP2_CANCEL) })
    req.pipe(stream)
    stream.once('response', (answer) => {
      const status = Number(answer[':status'] ?? 502)
      const out: OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(answer)) {
        if (!name.startsWith(':') && !HOP_BY_HOP.has(name) && value !== undefined) out[name] = value
      }
      res.writeHead(status, out)
    })
    let trailers: IncomingHttpHeaders | undefined
    stream.once('trailers', (received) => { trailers = received })
    stream.on('data', (chunk: Buffer) => {
      upstream.notifyResponseByteRead(stream)
      if (!res.write(chunk)) {
        stream.pause()
        res.once('drain', () => { stream.resume() })
      }
    })
    stream.once('end', () => {
      settled = true
      if (!res.headersSent) res.writeHead(502)
      // Trailers go only on HTTP/2, where gRPC has them; Connect over HTTP/1.1 sends none.
      if (trailers !== undefined && response instanceof Http2ServerResponse) {
        const kept: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(trailers)) if (!name.startsWith(':') && value !== undefined) kept[name] = value
        response.addTrailers(kept)
      }
      res.end()
    })
    stream.once('error', fail)
    stream.once('close', () => {
      // Reset without an end: the upstream cut the call.
      if (!settled) fail(new ConnectError('the call was cut', Code.Unavailable))
    })
  }, fail)
}
