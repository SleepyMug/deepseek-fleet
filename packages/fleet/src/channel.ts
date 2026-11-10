/**
 * The host's end of a box's channel (fleet-protocol's channel): an HTTP/2
 * server on a socket in a folder of the box's own, which the box has
 * mounted at the layout's `CHANNEL_DIR`, so that only that box reaches it,
 * and a stream that comes in on it is that box's. Each stream is a
 * connection a program in the box opened to a service's socket: one the
 * host takes is answered as opened and given to its taker as a stream, its
 * end a half-close either way, its destruction a cut; one it does not take
 * is refused. The folder outlives the server, so a host that listens again,
 * after a restart, reaches a box that runs already.
 * @module @sleepymug/fleet/channel
 */

import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Http2Server, type Http2Session, type ServerHttp2Stream } from 'node:http2'
import { basename, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { CHANNEL_WINDOW, CONNECTION_WINDOW, NO_SERVICE, OPENED, serviceOf } from '@sleepymug/fleet-protocol/channel'
import { CHANNEL } from '@sleepymug/fleet-protocol/layout'

/** The channel's socket in a box's folder of the host's, as the layout's `CHANNEL` is in the box. */
export function channelSocket(dir: string): string {
  return join(dir, basename(CHANNEL))
}

/**
 * Takes a connection a program in the box opened to a service's socket:
 * gives what takes its stream, or undefined for a service the box does not
 * have, which refuses it.
 */
export type ChannelTaker = (service: string) => ((stream: Duplex) => void) | undefined

export class Channel {
  private constructor(private readonly server: Http2Server, private readonly sessions: Set<Http2Session>) {}

  /**
   * Listen on the channel's socket in `dir`, made if missing: a folder only
   * the box it is mounted in reaches, and the host's owner.
   */
  static async listen(dir: string, take: ChannelTaker): Promise<Channel> {
    // Searchable by anyone, so that the box's root reaches it whatever its user is on the host; the folder above keeps others out.
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o711)
    const path = channelSocket(dir)
    // One left by a host before this one.
    await rm(path, { force: true })
    const sessions = new Set<Http2Session>()
    const server = createServer({ settings: { initialWindowSize: CONNECTION_WINDOW } })
    server.on('session', (session) => {
      sessions.add(session)
      session.once('close', () => { sessions.delete(session) })
      session.on('error', () => {})
      session.once('connect', () => { session.setLocalWindowSize(CHANNEL_WINDOW) })
    })
    server.on('stream', (stream: ServerHttp2Stream, headers) => {
      stream.on('error', () => {})
      const service = headers[':method'] === 'POST' ? serviceOf(headers[':path']) : undefined
      const taker = service === undefined ? undefined : take(service)
      if (taker === undefined) {
        stream.respond({ ':status': NO_SERVICE }, { endStream: true })
        return
      }
      stream.respond({ ':status': OPENED })
      taker(stream)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(path, 0o666)
    return new Channel(server, sessions)
  }

  /** Stop listening, and drop the helper's connection, which cuts its streams. */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    for (const session of this.sessions) session.destroy()
    this.sessions.clear()
    await closed
  }
}
