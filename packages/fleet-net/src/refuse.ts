/**
 * Refusing a call as its own protocol has it, by its content type, without
 * reading what it sends: gRPC and gRPC-Web as a response with its status in
 * its headers alone; Connect's streams as a stream that ends at once with
 * the error; and anything else, Connect's unary calls among them, as an
 * HTTP status with the error as JSON. So the caller's client reports the
 * error, with its code and details, as from the server itself.
 * @module @sleepymug/fleet-net/refuse
 */

import type { ServerResponse } from 'node:http'
import type { ConnectError } from '@connectrpc/connect'
import { codeToHttpStatus, endStreamFlag, endStreamToJson, errorToJsonBytes } from '@connectrpc/connect/protocol-connect'
import { setTrailerStatus } from '@connectrpc/connect/protocol-grpc'
import type { Request, Response } from './listen.ts'

const GRPC = /^application\/grpc(?:-web(?:-text)?)?(?:[+;]|$)/iu
const CONNECT_STREAM = /^application\/connect\+/iu

/** Answer `req` with `error`, as its protocol has it. */
export function refuse(req: Request, response: Response, error: ConnectError): void {
  // Both Node's responses take what is written here alike.
  const res = response as ServerResponse
  if (res.headersSent) {
    res.destroy()
    return
  }
  const type = String(req.headers['content-type'] ?? '')
  // What the caller still sends is not read.
  req.resume()
  if (GRPC.test(type)) {
    const status = new Headers()
    setTrailerStatus(status, error)
    res.writeHead(200, { 'content-type': type, ...Object.fromEntries(status) })
    res.end()
  } else if (CONNECT_STREAM.test(type)) {
    const json = Buffer.from(JSON.stringify(endStreamToJson(error.metadata, error, undefined)))
    const envelope = Buffer.alloc(5 + json.length)
    envelope.writeUInt8(endStreamFlag, 0)
    envelope.writeUInt32BE(json.length, 1)
    json.copy(envelope, 5)
    res.writeHead(200, { 'content-type': type })
    res.end(envelope)
  } else {
    res.writeHead(codeToHttpStatus(error.code), { 'content-type': 'application/json' })
    res.end(errorToJsonBytes(error, {}))
  }
}
