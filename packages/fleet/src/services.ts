/**
 * The services registered with the fleet host (docs/fleet/services/index.md):
 * each a gateway, a socket of its own on the host, and a node package, the
 * means of calling it, which the host stages as installed, with the
 * packages it depends on, and copies into every box that has the service,
 * its commands on the box's PATH. A connection a program in a box opens to
 * the service's socket there the host passes on to the gateway, a
 * connection of its own to the service's socket, after a line saying which
 * box it comes from, as the host knows it, never as the box says.
 * @module @sleepymug/fleet/services
 */

import { readFile, rename, rm, mkdir, mkdtemp, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, isAbsolute, join, posix } from 'node:path'
import type { Duplex } from 'node:stream'
import { stagePackage } from '@sleepymug/fleet-box/image/stage'
import type { Preamble, ServiceInfo, ServiceSpec } from '@sleepymug/fleet-protocol/fleet'
import type { ServiceInBox } from '@sleepymug/fleet-protocol/helper'
import { SERVICES_DIR } from '@sleepymug/fleet-protocol/layout'
import { digestOf } from './digest.ts'
import type { RunBox } from './managed.ts'
import type { Platform } from './platform.ts'
import type { BoxRecord } from './registry.ts'
import { messageOf } from './util/error.ts'

/** A service's name: lowercase letters, digits and hyphens, a letter first. */
const NAME = /^[a-z][a-z0-9-]{0,62}$/u
/** A command's name. */
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** A service registered, with its staged package and who registered it. */
interface Registered extends ServiceInfo {
  /** Its staged package, `<name>@<digest>` in the host's cache. */
  staged: string
  endpoint: string
  owner: unknown
}

export interface ServicesDeps {
  /** Where the services' packages are staged, each `<name>@<digest>`. */
  cache: string
  platform: Platform
  /** Told each time the services registered change, so that the started boxes get them. */
  changed: () => void
}

export class Services {
  private readonly registered = new Map<string, Registered>()

  constructor(private readonly deps: ServicesDeps) {}

  /**
   * Register a service, for its owner, a client of the host, until it
   * unregisters it, or its connection ends: its package staged and digested.
   * @throws for a spec that is not one, a name another owner has, or a command another service has.
   */
  async register(spec: ServiceSpec, owner: unknown): Promise<ServiceInfo> {
    const { name, description, package: root, env = {}, endpoint } = checked(spec)
    const other = this.registered.get(name)
    if (other !== undefined && other.owner !== owner) throw new Error(`fleet: a service ${name} is registered already`)
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown; bin?: unknown }
    const bins = binsOf(manifest)
    for (const service of this.registered.values()) {
      if (service.name === name) continue
      const clash = Object.keys(bins).find(bin => Object.hasOwn(service.bins, bin))
      if (clash !== undefined) throw new Error(`fleet: the service ${service.name} has the command ${clash} already`)
    }
    await mkdir(this.deps.cache, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(this.deps.cache, `.${name}-`))
    let digest: string
    try {
      await stagePackage(root, join(staging, 'package'), process.arch)
      digest = await digestOf(join(staging, 'package'))
      const staged = join(this.deps.cache, `${name}@${digest}`)
      if (!(await exists(staged))) await rename(join(staging, 'package'), staged)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    const service: Registered = { name, description, bins, env, digest, staged: join(this.deps.cache, `${name}@${digest}`), endpoint, owner }
    this.registered.set(name, service)
    this.deps.platform.log(`registered the service ${name}, its package ${digest}, its commands ${Object.keys(bins).join(', ') || 'none'}`)
    this.deps.changed()
    return infoOf(service)
  }

  /** Unregister a service, if its owner registered it, or the host does; the boxes keep its package, and lose the rest. */
  unregister(name: string, owner?: unknown): void {
    const service = this.registered.get(name)
    if (service === undefined || (owner !== undefined && service.owner !== owner)) return
    this.registered.delete(name)
    this.deps.platform.log(`unregistered the service ${name}`)
    this.deps.changed()
  }

  /** Unregister every service of an owner, as its connection ends. */
  unregisterAll(owner: unknown): void {
    for (const service of [...this.registered.values()]) if (service.owner === owner) this.unregister(service.name, owner)
  }

  list(): ServiceInfo[] {
    return [...this.registered.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(infoOf)
  }

  /** The services a box has now: each registered, of those it names, or every one. */
  of(record: Pick<BoxRecord, 'services'>): ServiceInfo[] {
    return this.list().filter(service => record.services === null || record.services.includes(service.name))
  }

  /**
   * Put a started box's services in it: copy in each package it lacks,
   * then have its helper make them its services.
   */
  async provision(box: RunBox, record: Pick<BoxRecord, 'services'>): Promise<void> {
    const services = this.of(record).map(info => this.registered.get(info.name) as Registered)
    const installed = await box.request('services.installed', {})
    for (const service of services) {
      if (installed[service.name]?.includes(service.digest) === true) continue
      await box.copyIn(service.staged, posix.join(SERVICES_DIR, basename(service.staged)))
    }
    const inBox: ServiceInBox[] = services.map(({ name, digest, bins, env }) => ({ name, digest, bins, env }))
    await box.request('services.sync', { services: inBox })
  }

  /**
   * Pass a connection a program in a box opened to a service's socket on to
   * the service, after a line saying which box it comes from; a service the
   * box does not have, or that is not registered now, cuts it.
   */
  relay(record: BoxRecord, name: string, connection: Duplex): void {
    const service = this.registered.get(name)
    if (service === undefined || (record.services !== null && !record.services.includes(name))) {
      connection.destroy(new Error(`the service ${name} is not available`))
      return
    }
    const gateway = createConnection({ path: service.endpoint, allowHalfOpen: true })
    const preamble: Preamble = { box: record.id, labels: record.labels }
    gateway.write(`${JSON.stringify(preamble)}\n`)
    connection.pipe(gateway)
    gateway.pipe(connection)
    connection.on('error', () => { gateway.destroy() })
    gateway.on('error', (error) => {
      this.deps.platform.log(`could not relay a connection of ${record.id} to the service ${name}: ${messageOf(error)}`)
      connection.destroy(error)
    })
    gateway.on('close', () => { if (!connection.writableEnded) connection.destroy() })
  }
}

function infoOf({ name, description, bins, env, digest }: Registered): ServiceInfo {
  return { name, description, bins: { ...bins }, env: { ...env }, digest }
}

/** A package's commands, as npm reads its `bin`: one named for the package, without its scope, or each named. */
function binsOf(manifest: { name?: unknown; bin?: unknown }): Record<string, string> {
  const { name, bin } = manifest
  const given: Record<string, unknown> = typeof bin === 'string'
    ? { [String(name).replace(/^@[^/]+\//u, '')]: bin }
    : typeof bin === 'object' && bin !== null ? { ...bin } : {}
  const bins: Record<string, string> = {}
  for (const [command, file] of Object.entries(given)) {
    if (!BIN.test(command) || typeof file !== 'string') throw new Error(`fleet: the package's command ${command} is not one`)
    const path = posix.normalize(file)
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`fleet: the package's command ${command} is not in the package`)
    bins[command] = path
  }
  return bins
}

function checked(spec: ServiceSpec): ServiceSpec {
  const { name, description, package: root, env, endpoint } = (spec ?? {}) as Partial<ServiceSpec>
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('fleet: a service has a name: lowercase letters, digits and hyphens, a letter first')
  if (typeof description !== 'string' || description.trim() === '') throw new TypeError(`fleet: the service ${name} says what it is, in its description`)
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError(`fleet: the service ${name} names its package, a folder on this host, absolutely`)
  if (typeof endpoint !== 'string' || !isAbsolute(endpoint)) throw new TypeError(`fleet: the service ${name} names its endpoint, a socket on this host, absolutely`)
  if (env !== undefined && (typeof env !== 'object' || env === null || !Object.values(env).every(value => typeof value === 'string'))) {
    throw new TypeError(`fleet: the service ${name}'s env is strings`)
  }
  return { name, description, package: root, endpoint, ...env === undefined ? {} : { env } }
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}
