/**
 * The box's services (fleet-protocol's layout): each service's package, as
 * the host copied it in as `<name>@<digest>`, a link by its name to the one
 * in use; its commands, links in the folder of commands, which is on the
 * PATH of every process the helper starts; its environment, which each of
 * them starts with; and its socket, which the helper listens on, and whose
 * every connection it relays to the host, which passes it on to the
 * service. A connection's bytes cross as `conn-data`, at most
 * {@link CONNECTION_WINDOW} of them unacknowledged each way, so that a side
 * that reads slowly slows the other; either side's end is a half-close, and
 * a cut connection is cut on both sides. Which box a connection comes from
 * is the host's to say, not the program's, so the helper checks only that
 * the service is the box's. Each helper has its own {@link Services}.
 * @module @sleepymug/fleet-box/helper/cmd/services
 */

import { chmod, mkdir, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { BIN_DIR, SERVICES_DIR, SERVICES_VARIABLE, SOCKETS_DIR } from '@sleepymug/fleet-protocol/layout'
import { CONNECTION_WINDOW, type ConnectionAck, type ConnectionData, type ConnectionEnd, type HelperMessage, type Methods, type ServiceInBox } from '@sleepymug/fleet-protocol/helper'
import { withBin, type Environment } from './env.ts'

/** Where the services' things are: the box's own, unless a test has them elsewhere. */
export interface ServicesLayout {
  services: string
  bin: string
  sockets: string
}

export const BOX_LAYOUT: ServicesLayout = { services: SERVICES_DIR, bin: BIN_DIR, sockets: SOCKETS_DIR }

/** A service's name: lowercase letters, digits and hyphens, a letter first. */
const NAME = /^[a-z][a-z0-9-]*$/u
/** A package's digest. */
const DIGEST = /^[0-9a-f]{8,64}$/u
/** A command's name. */
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** One relayed connection, as the helper has it. */
interface Relayed {
  socket: Socket
  /** What this side sent the host that the host has not acknowledged. */
  unacked: number
  /** This side sent its end. */
  ended: boolean
  /** The host's side sent its end. */
  hostEnded: boolean
}

export class Services {
  private readonly servers = new Map<string, Server>()
  private readonly connections = new Map<number, Relayed>()
  /** What the services listed last added to the environment, by name. */
  private added: Record<string, string> = {}
  private nextId = 1

  /**
   * @param send - sends a message to the host; false while the host is behind.
   * @param env - the helper's environment, which every process it starts starts from, the services' added.
   */
  constructor(
    private readonly send: (message: HelperMessage) => boolean,
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

  /** What the host sent on a connection: its service's bytes, an acknowledgement, or its end. */
  receive(message: ConnectionData | ConnectionAck | ConnectionEnd): void {
    const relayed = this.connections.get(message.conn)
    if (relayed === undefined) return
    switch (message.type) {
      case 'conn-data': {
        const bytes = Buffer.from(message.data, 'base64')
        relayed.socket.write(bytes, () => { this.send({ type: 'conn-ack', conn: message.conn, bytes: bytes.length }) })
        return
      }
      case 'conn-ack':
        relayed.unacked -= message.bytes
        if (relayed.unacked < CONNECTION_WINDOW && relayed.socket.isPaused()) relayed.socket.resume()
        return
      case 'conn-end':
        relayed.hostEnded = true
        if (message.error === undefined) relayed.socket.end()
        else relayed.socket.destroy()
    }
  }

  /** Stop listening, and cut every connection. */
  async close(): Promise<void> {
    for (const { socket } of this.connections.values()) socket.destroy()
    this.connections.clear()
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

  /** Relay a connection a program in the box opened to a service's socket. */
  private accept(service: string, socket: Socket): void {
    const conn = this.nextId++
    const relayed: Relayed = { socket, unacked: 0, ended: false, hostEnded: false }
    this.connections.set(conn, relayed)
    this.send({ type: 'conn-open', conn, service })
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => {
      relayed.unacked += chunk.length
      this.send({ type: 'conn-data', conn, data: chunk.toString('base64') })
      if (relayed.unacked >= CONNECTION_WINDOW) socket.pause()
    })
    socket.once('end', () => {
      relayed.ended = true
      this.send({ type: 'conn-end', conn })
    })
    socket.once('close', () => {
      this.connections.delete(conn)
      // Cut before both sides were done, so the host's side is cut too.
      if (!relayed.ended || !relayed.hostEnded) this.send({ type: 'conn-end', conn, error: 'the program in the box closed the connection' })
    })
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
