/**
 * The box's services (fleet-protocol's layout): each service's package, as
 * the host copied it in as `<name>@<digest>`, a link by its name to the one
 * in use; its commands, links in the folder of commands, which is on the
 * PATH of every process the helper starts; its environment, which each of
 * them starts with; and its socket, which the helper listens on, and whose
 * every connection it carries to the host as a stream of the box's channel
 * (fleet-protocol's channel), which the host passes on to the service:
 * either side's end is a half-close, and a cut connection is cut on both
 * sides. The helper makes the channel's connection as the first program
 * connects, and again after the host drops it, as when it restarts. Which
 * box a connection comes from is the host's to say, by the channel it comes
 * in on, so the helper checks only that the service is the box's. Each
 * helper has its own {@link Services}.
 * @module @sleepymug/fleet-box/helper/cmd/services
 */

import { chmod, mkdir, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises'
import { connect as connectSession, constants, type ClientHttp2Session } from 'node:http2'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { CHANNEL_WINDOW, CONNECTION_WINDOW, OPENED, servicePath } from '@sleepymug/fleet-protocol/channel'
import { BIN_DIR, CHANNEL, SERVICES_DIR, SERVICES_VARIABLE, SOCKETS_DIR } from '@sleepymug/fleet-protocol/layout'
import type { Methods, ServiceInBox } from '@sleepymug/fleet-protocol/helper'
import { withBin, type Environment } from './env.ts'

/** Where the services' things are: the box's own, unless a test has them elsewhere. */
export interface ServicesLayout {
  services: string
  bin: string
  sockets: string
  /** The channel's socket. */
  channel: string
}

export const BOX_LAYOUT: ServicesLayout = { services: SERVICES_DIR, bin: BIN_DIR, sockets: SOCKETS_DIR, channel: CHANNEL }

/** A service's name: lowercase letters, digits and hyphens, a letter first. */
const NAME = /^[a-z][a-z0-9-]*$/u
/** A package's digest. */
const DIGEST = /^[0-9a-f]{8,64}$/u
/** A command's name. */
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export class Services {
  private readonly servers = new Map<string, Server>()
  private readonly connections = new Set<Socket>()
  /** The channel's connection, once a program connected, until the host drops it. */
  private session: ClientHttp2Session | undefined
  /** What the services listed last added to the environment, by name. */
  private added: Record<string, string> = {}

  /** @param env - the helper's environment, which every process it starts starts from, the services' added. */
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly layout: ServicesLayout = BOX_LAYOUT,
  ) {}

  /** Make the services' folders, and name their sockets and commands in the environment, before any process starts. */
  async prepare(): Promise<void> {
    for (const folder of [this.layout.services, this.layout.bin, this.layout.sockets]) await mkdir(folder, { recursive: true })
    this.env[SERVICES_VARIABLE] = this.layout.sockets
    this.env.PATH = withBin(this.env as Environment, this.layout.bin)
  }

  /** The digests of the packages the box holds, by the service's name. */
  async installed(): Promise<Methods['services.installed']['result']> {
    const held: Record<string, string[]> = {}
    for (const entry of await readdir(this.layout.services, { withFileTypes: true })) {
      const at = entry.name.lastIndexOf('@')
      if (!entry.isDirectory() || at <= 0) continue
      const name = entry.name.slice(0, at)
      ;(held[name] ??= []).push(entry.name.slice(at + 1))
    }
    return held
  }

  /** Make the box's services those listed, as `services.sync` asks (fleet-protocol's helper). */
  async sync(params: Methods['services.sync']['params']): Promise<null> {
    const services = checked(params)
    const listed = new Set(services.map(service => service.name))
    for (const { name, digest } of services) {
      const dir = join(this.layout.services, `${name}@${digest}`)
      if (!(await isDir(dir))) throw new Error(`the box has no package ${digest} of the service ${name}`)
      await relink(join(this.layout.services, name), `${name}@${digest}`)
      for (const old of (await this.installed())[name] ?? []) {
        if (old !== digest) await rm(join(this.layout.services, `${name}@${old}`), { recursive: true, force: true })
      }
    }
    // A service no longer listed keeps its package, which the next sync that lists it uses again.
    for (const entry of await readdir(this.layout.services, { withFileTypes: true })) {
      if (entry.isSymbolicLink() && !listed.has(entry.name)) await rm(join(this.layout.services, entry.name), { force: true })
    }
    await this.linkBins(services)
    const added: Record<string, string> = {}
    for (const { env } of services) Object.assign(added, env)
    for (const key of Object.keys(this.added)) if (!Object.hasOwn(added, key)) Reflect.deleteProperty(this.env, key)
    Object.assign(this.env, added)
    this.added = added
    for (const [name, server] of this.servers) {
      if (listed.has(name)) continue
      this.servers.delete(name)
      server.close()
    }
    for (const { name } of services) if (!this.servers.has(name)) this.servers.set(name, await this.listen(name))
    return null
  }

  /** Stop listening, and cut every connection. */
  async close(): Promise<void> {
    for (const socket of this.connections) socket.destroy()
    this.connections.clear()
    this.session?.destroy()
    this.session = undefined
    await Promise.all([...this.servers.values()].map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
    this.servers.clear()
  }

  /** Each listed service's commands, linked by name in the folder of commands, through the link by its service's name; nothing else there. */
  private async linkBins(services: readonly ServiceInBox[]): Promise<void> {
    const wanted = new Map<string, string>()
    for (const { name, bins } of services) {
      for (const [bin, file] of Object.entries(bins)) if (!wanted.has(bin)) wanted.set(bin, join(this.layout.services, name, file))
    }
    for (const entry of await readdir(this.layout.bin)) {
      const at = join(this.layout.bin, entry)
      if (wanted.get(entry) !== await readlink(at).catch(() => undefined)) await rm(at, { recursive: true, force: true })
    }
    for (const [bin, target] of wanted) {
      await symlink(target, join(this.layout.bin, bin)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      // A package manager makes a command executable as it installs it; a copied package's may not be.
      await chmod(await realpath(target), 0o755).catch(() => {})
    }
  }

  /** Listen on a service's socket, which whoever runs in the box may open: the box is its own. */
  private async listen(name: string): Promise<Server> {
    const path = join(this.layout.sockets, `${name}.sock`)
    // One left by a helper before this one, which was ended with the box's last start.
    await rm(path, { force: true })
    const server = createServer({ allowHalfOpen: true }, (socket) => { this.accept(name, socket) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(path, 0o666)
    return server
  }

  /** Carry a connection a program in the box opened to a service's socket to the host, as a stream of the channel. */
  private accept(service: string, socket: Socket): void {
    this.connections.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => { this.connections.delete(socket) })
    let stream: ReturnType<ClientHttp2Session['request']>
    try {
      stream = this.channel().request({ ':method': 'POST', ':path': servicePath(service) }, { endStream: false })
    } catch {
      socket.destroy()
      return
    }
    stream.once('response', (headers) => {
      if (headers[':status'] === OPENED) stream.pipe(socket)
      else socket.destroy()
    })
    socket.pipe(stream)
    // Cut on either side before both were done: the other is cut too.
    stream.once('close', () => { if (stream.rstCode !== constants.NGHTTP2_NO_ERROR || !stream.readableEnded) socket.destroy() })
    stream.on('error', () => {})
    // A program that ended what it sent is done with it once the stream's end is sent, so only one cut before cuts the stream.
    socket.once('close', () => { if (!socket.readableEnded && !stream.closed) stream.close(constants.NGHTTP2_CANCEL) })
  }

  /** The channel's connection, made as it is first wanted, and again once the host dropped it. */
  private channel(): ClientHttp2Session {
    if (this.session !== undefined && !this.session.closed && !this.session.destroyed) return this.session
    const session = connectSession('http://box', {
      createConnection: () => createConnection(this.layout.channel),
      settings: { initialWindowSize: CONNECTION_WINDOW },
    })
    session.on('error', () => {})
    session.once('connect', () => { session.setLocalWindowSize(CHANNEL_WINDOW) })
    session.once('close', () => { if (this.session === session) this.session = undefined })
    this.session = session
    return session
  }
}

/** Make `link` lead to `target` at once, in place of what it led to. */
async function relink(link: string, target: string): Promise<void> {
  if (await readlink(link).catch(() => undefined) === target) return
  const staged = `${link}.${process.pid}.link`
  await rm(staged, { force: true })
  await symlink(target, staged)
  await rename(staged, link)
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)) !== undefined
  } catch {
    return false
  }
}

function checked(params: Methods['services.sync']['params']): ServiceInBox[] {
  const services = (params as Partial<Methods['services.sync']['params']> | null)?.services
  const problem = 'services.sync takes services, a list of { name, digest, bins, env }'
  if (!Array.isArray(services)) throw new TypeError(problem)
  const strings = (value: unknown): value is Record<string, string> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(entry => typeof entry === 'string')
  for (const service of services as unknown[]) {
    const { name, digest, bins, env } = (service ?? {}) as Partial<ServiceInBox>
    if (typeof name !== 'string' || !NAME.test(name) || typeof digest !== 'string' || !DIGEST.test(digest) || !strings(bins) || !strings(env)) throw new TypeError(problem)
    for (const [bin, file] of Object.entries(bins)) {
      if (!BIN.test(bin) || file.startsWith('/') || file.split('/').includes('..')) throw new TypeError(`services.sync: ${name}'s command ${bin} is not one in its package`)
    }
  }
  return services
}
