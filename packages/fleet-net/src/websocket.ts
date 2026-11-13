/**
 * WebSocket (RFC 6455) as a byte stream: what one end writes, the other
 * reads, carried in binary messages whose bounds mean nothing. It runs
 * over whatever the handshake left: an HTTP/1.1 connection after its 101,
 * or an HTTP/2 stream after its extended CONNECT (RFC 8441). Each message
 * is passed on as it comes, never held whole.
 * @module @sleepymug/fleet-net/websocket
 */

import { createHash, randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'

/** The only version of WebSocket there is. */
export const WEBSOCKET_VERSION = '13'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A client's `Sec-WebSocket-Key`. */
export function webSocketKey(): string {
  return randomBytes(16).toString('base64')
}

/** The server's `Sec-WebSocket-Accept` for a client's `key`. */
export function webSocketAccept(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** The subprotocols a `Sec-WebSocket-Protocol` header offers, in its order. */
export function webSocketProtocols(header: string | string[] | undefined): string[] {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header]
  return values.flatMap(value => value.split(',')).map(value => value.trim()).filter(value => value !== '')
}

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

/** What the ends say when they close: all went well, or the other end broke the protocol. */
const CLOSE = { normal: 1000, protocolError: 1002 } as const

/**
 * Bytes over `connection` as WebSocket's binary messages. A client masks
 * what it sends, and a server takes only what is masked, as RFC 6455 has
 * it. Ending it closes the WebSocket, then the connection; the other end
 * closing it ends what is read; destroying either destroys both. It never
 * fails with an error: a connection lost or a protocol broken closes it.
 */
export function webSocketStream(connection: Duplex, role: 'client' | 'server'): Duplex {
  return new WebSocketStream(connection, role === 'client')
}

class WebSocketStream extends Duplex {
  readonly #connection: Duplex
  /** Whether this end masks what it sends: a client's does, and a server's takes only that. */
  readonly #masks: boolean
  #closeSent = false
  /** Whether the other end closed, after which nothing it sends is read. */
  #closeReceived = false
  /** What is read of the frame now coming. */
  #header = Buffer.alloc(0)
  #frame: { opcode: number; remaining: number; mask: Buffer | undefined; at: number; control: Buffer[] } | undefined

  constructor(connection: Duplex, masks: boolean) {
    super({ allowHalfOpen: false })
    this.#connection = connection
    this.#masks = masks
    connection.on('data', (chunk: Buffer) => { this.#receive(chunk) })
    connection.once('end', () => { this.push(null) })
    connection.once('close', () => { this.destroy() })
    // The connection failing closes the stream, quietly: what reads it,
    // HTTP/2 over Node's JSStreamSocket, takes an error mid-write badly.
    connection.on('error', () => { this.destroy() })
  }

  override _read(): void {
    this.#connection.resume()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#connection.write(this.#frameOf(OP.binary, chunk), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#close(CLOSE.normal)
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#connection.destroy()
    callback(error)
  }

  /** Send a close, once, and end the connection. */
  #close(code: number): void {
    if (this.#closeSent) return
    this.#closeSent = true
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code)
    this.#connection.end(this.#frameOf(OP.close, payload))
  }

  /** The other end broke the protocol, `reason` saying how: close, and say no more. */
  #fail(_reason: string): void {
    this.#close(CLOSE.protocolError)
    this.destroy()
  }

  #receive(chunk: Buffer): void {
    let at = 0
    while (at < chunk.length && !this.destroyed && !this.#closeReceived) {
      if (this.#frame === undefined) {
        const needed = this.#headerLength()
        const take = Math.min(needed - this.#header.length, chunk.length - at)
        this.#header = Buffer.concat([this.#header, chunk.subarray(at, at + take)])
        at += take
        // The header's length is known only once its first bytes are.
        if (this.#header.length === this.#headerLength()) this.#startFrame()
        continue
      }
      const frame = this.#frame
      const take = Math.min(frame.remaining, chunk.length - at)
      const payload = unmask(chunk.subarray(at, at + take), frame.mask, frame.at)
      at += take
      frame.at += take
      frame.remaining -= take
      if (frame.opcode >= OP.close) frame.control.push(payload)
      else if (payload.length > 0 && !this.push(payload)) this.#connection.pause()
      if (frame.remaining === 0) this.#endFrame()
    }
  }

  /** The length of the frame's header, as far as what is read of it tells. */
  #headerLength(): number {
    const header = this.#header
    if (header.length < 2) return 2
    const length = (header[1] as number) & 0x7f
    const masked = ((header[1] as number) & 0x80) !== 0
    return 2 + (length === 126 ? 2 : length === 127 ? 8 : 0) + (masked ? 4 : 0)
  }

  #startFrame(): void {
    const header = this.#header
    this.#header = Buffer.alloc(0)
    const first = header[0] as number
    const second = header[1] as number
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let at = 2
    if (length === 126) {
      length = header.readUInt16BE(2)
      at = 4
    } else if (length === 127) {
      const long = header.readBigUInt64BE(2)
      if (long > BigInt(Number.MAX_SAFE_INTEGER)) return this.#fail('a frame too long to count')
      length = Number(long)
      at = 10
    }
    if ((first & 0x70) !== 0) return this.#fail('reserved bits set, with no extension agreed')
    if (!Object.values(OP).includes(opcode as never)) return this.#fail(`an unknown opcode, ${opcode}`)
    if (opcode >= OP.close && (!fin || length > 125)) return this.#fail('a control frame fragmented or too long')
    // A client masks what it sends, and a server never does.
    if (masked === this.#masks) return this.#fail(masked ? 'a masked frame from the server' : 'an unmasked frame from the client')
    this.#frame = { opcode, remaining: length, mask: masked ? header.subarray(at, at + 4) : undefined, at: 0, control: [] }
    if (length === 0) this.#endFrame()
  }

  #endFrame(): void {
    const frame = this.#frame
    this.#frame = undefined
    if (frame === undefined) return
    const payload = Buffer.concat(frame.control)
    switch (frame.opcode) {
      case OP.ping:
        if (!this.#closeSent) this.#connection.write(this.#frameOf(OP.pong, payload))
        break
      case OP.close:
        // Answered as it came, with its code, and the stream ends.
        this.#closeReceived = true
        this.#close(payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal)
        this.push(null)
        break
      default:
        break
    }
  }

  #frameOf(opcode: number, payload: Buffer): Buffer {
    const length = payload.length
    const extended = length < 126 ? 0 : length < 0x10000 ? 2 : 8
    const header = Buffer.alloc(2 + extended + (this.#masks ? 4 : 0))
    header[0] = 0x80 | opcode
    header[1] = (this.#masks ? 0x80 : 0) | (extended === 0 ? length : extended === 2 ? 126 : 127)
    if (extended === 2) header.writeUInt16BE(length, 2)
    else if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2)
    if (!this.#masks) return Buffer.concat([header, payload])
    const mask = randomBytes(4)
    mask.copy(header, 2 + extended)
    return Buffer.concat([header, unmask(payload, mask, 0)])
  }
}

/** `bytes` XORed with `mask`, starting `at` that far into the payload; masking and unmasking alike. */
function unmask(bytes: Buffer, mask: Buffer | undefined, at: number): Buffer {
  if (mask === undefined) return bytes
  const out = Buffer.allocUnsafe(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] as number) ^ (mask[(at + i) & 3] as number)
  return out
}
