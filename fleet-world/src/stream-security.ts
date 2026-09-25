/**
 * TLS-PSK authentication of one helper stream socket. This mirrors dsh-ssh's
 * private `stream-security` module, which the package does not export; the
 * helper's stream servers accept exactly these options.
 * @module fleet-world/stream-security
 */

import type { Socket } from 'node:net'
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls'

/** Certificate-free PSK authentication and AEAD records, as the helper's servers require. */
const STREAM_TLS_OPTIONS = {
  ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
} as const satisfies ConnectionOptions

/**
 * Authenticate a connected stream socket with the key the helper issued for it.
 * @param socket - the connected Unix socket.
 * @param capability - the per-stream 256-bit key, hex-encoded.
 * @param timeoutMs - deadline for the TLS handshake.
 * @param signal - cancels authentication and the resulting stream.
 * @returns the authenticated stream, paused; the key itself is never sent.
 */
export async function authenticateStream(socket: Socket, capability: string, timeoutMs: number, signal?: AbortSignal): Promise<TLSSocket> {
  if (signal?.aborted) { socket.destroy(); signal.throwIfAborted() }
  const stream = connect({
    ...STREAM_TLS_OPTIONS, socket, rejectUnauthorized: true,
    pskCallback: () => ({ psk: Buffer.from(capability, 'hex'), identity: 'dsh-stream' }),
    // The PSK proves the peer's identity; there is no certificate or hostname.
    checkServerIdentity: () => undefined,
  })
  const abort = (): void => { stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason))) }
  signal?.addEventListener('abort', abort, { once: true })
  stream.once('close', () => { signal?.removeEventListener('abort', abort) })
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stream.off('secureConnect', secured)
        stream.off('error', failed)
        stream.off('close', closed)
        clearTimeout(timer)
      }
      const secured = (): void => { cleanup(); stream.disableRenegotiation(); stream.pause(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('fleet-world: helper stream closed during authentication')) }
      const timer = setTimeout(() => { failed(new Error('fleet-world: helper stream authentication timed out')) }, timeoutMs)
      stream.once('secureConnect', secured)
      stream.once('error', failed)
      stream.once('close', closed)
    })
    return stream
  } catch (error) { stream.destroy(); throw error }
}
