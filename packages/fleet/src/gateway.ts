/**
 * The gateway (docs/fleet/index.md), put together from what it is given:
 * the boxes it made (./boxes/), each a container through its driver with
 * fleet's helper in it while it runs, kept until they are removed, and
 * running from their start until they are stopped, as their creators ask;
 * and the services (./services/), each a
 * spec staged and a server's tunnel naming it, whose clients and packages
 * it puts in the boxes made with them. It knows nothing of who uses its
 * boxes, or of what its services do: a box is its id, its labels and its
 * services; a service is its name, its schema and its server. Its HTTP/2
 * surface is ./http/; this is what that surface asks of it.
 * @module @sleepymug/fleet/gateway
 */

import { mkdir } from 'node:fs/promises'
import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError } from '@connectrpc/connect'
import { runtimeRoots } from '@sleepymug/fleet-codegen'
import { type Box, BoxSchema, BoxState, type CreateBoxRequest, type Service, ServiceSchema, type StageServiceRequest } from '@sleepymug/fleet-protocol/gateway'
import { stageModules } from '@sleepymug/fleet-pack'
import type { AcceptedTunnel } from '@sleepymug/fleet-net'
import { contentsOf, type Contents } from './boxes/contents.ts'
import type { BoxDriver } from './boxes/driver.ts'
import { helperLink } from './boxes/link.ts'
import { ManagedBox } from './boxes/managed.ts'
import { Registry, type BoxRecord } from './boxes/registry.ts'
import { noBox, noPackage, noService, unknownSpec } from './failure.ts'
import type { FleetPaths } from './home.ts'
import type { Platform } from './platform.ts'
import { Registrations, type Registration } from './services/registrations.ts'
import { Specs, type Spec } from './services/specs.ts'
import { Store } from './store.ts'

export interface GatewayDeps {
  paths: FleetPaths
  driver: BoxDriver
  platform: Platform
  /** The image of a box made without one. */
  image: string
}

/** What follows a box's state: told it at each change, and `removed` once it is gone for good. */
export type BoxListener = (state: BoxState | 'removed') => void

export class FleetGateway {
  readonly store: Store
  readonly specs: Specs
  readonly registrations: Registrations
  private readonly registry: Registry
  private readonly boxes = new Map<string, { managed: ManagedBox; record: BoxRecord }>()
  private readonly listeners = new Map<string, Set<BoxListener>>()

  private constructor(private readonly deps: GatewayDeps, private readonly runtime: string) {
    this.store = new Store(deps.paths.store)
    this.specs = new Specs(deps.paths.specs, this.store)
    this.registry = new Registry(deps.paths.boxes)
    this.registrations = new Registrations((name, registration) => {
      deps.platform.log(registration === undefined ? `the service ${name} is gone` : `registered the service ${name}, its spec ${registration.spec.digest.slice(0, 12)}`)
    })
  }

  /** A gateway in its home: the boxes its records name, and what its services' clients import, staged. */
  static async open(deps: GatewayDeps): Promise<FleetGateway> {
    await mkdir(deps.paths.home, { recursive: true, mode: 0o700 })
    const store = new Store(deps.paths.store)
    const roots = await runtimeRoots()
    const runtime = await store.make(dir => stageModules(roots, dir))
    const gateway = new FleetGateway(deps, runtime)
    for (const record of await gateway.registry.list()) gateway.keep(record)
    return gateway
  }

  // The boxes.

  /** Make a box, stopped, with the services it names, each as registered now. */
  async createBox(request: CreateBoxRequest): Promise<Box> {
    const specs = request.services.map((name) => {
      const registration = this.registrations.get(name)
      if (registration === undefined) throw noService(`no service ${name} is registered`)
      return registration.spec
    })
    if (new Set(request.services).size !== request.services.length) throw new ConnectError('fleet: a box names each of its services once', Code.InvalidArgument)
    const commands = new Map<string, string>()
    const env: Record<string, string> = {}
    for (const spec of specs) {
      for (const command of Object.keys(await this.specs.commands(spec))) {
        const other = commands.get(command)
        if (other !== undefined) throw new ConnectError(`fleet: ${other} and ${spec.name} both have the command ${command}`, Code.InvalidArgument)
        commands.set(command, spec.name)
      }
      Object.assign(env, spec.env)
    }
    Object.assign(env, request.env)
    const record: BoxRecord = {
      id: `box-${this.deps.platform.newId()}`,
      image: request.image === '' ? this.deps.image : request.image,
      labels: { ...request.labels },
      env,
      services: specs.map(spec => ({ name: spec.name, spec: spec.digest })),
      createdAt: this.deps.platform.now().toISOString(),
    }
    // The record first, so a gateway that dies before the container is made leaves a box gone, never a container nothing knows.
    await this.registry.put(record)
    try {
      await this.deps.driver.create({ id: record.id, image: record.image, env: record.env, labels: record.labels })
    } catch (error) {
      await this.deps.driver.remove(record.id).catch(() => {})
      await this.registry.delete(record.id)
      throw error
    }
    this.deps.platform.log(`created ${record.id}${Object.entries(record.labels).map(([key, value]) => ` ${key}=${value}`).join('')}`)
    return this.infoOf(this.keep(record))
  }

  /** Every box, oldest first, or those whose labels hold each of `labels`. */
  listBoxes(labels: Readonly<Record<string, string>> = {}): Box[] {
    return [...this.boxes.values()]
      .filter(({ record }) => Object.entries(labels).every(([key, value]) => record.labels[key] === value))
      .sort((a, b) => (a.record.createdAt < b.record.createdAt ? -1 : a.record.createdAt > b.record.createdAt ? 1 : 0))
      .map(kept => this.infoOf(kept))
  }

  getBox(id: string): Box {
    return this.infoOf(this.find(id))
  }

  /** The box, as the gateway keeps it. */
  box(id: string): ManagedBox {
    return this.find(id).managed
  }

  /** The services a box was made with, by name. */
  servicesOf(id: string): readonly string[] {
    return this.find(id).record.services.map(service => service.name)
  }

  /** The box's labels. */
  labelsOf(id: string): Readonly<Record<string, string>> {
    return this.find(id).record.labels
  }

  async removeBox(id: string): Promise<void> {
    const { managed } = this.find(id)
    await managed.remove(async () => {
      await this.registry.delete(id)
      this.boxes.delete(id)
    })
    this.deps.platform.log(`removed ${id}`)
    for (const listener of this.listeners.get(id) ?? []) listener('removed')
    this.listeners.delete(id)
  }

  /** Follow a box's state: `listener` is told it now and at each change, until the returned stop, or the box's removal. */
  watch(id: string, listener: BoxListener): () => void {
    const { managed } = this.find(id)
    const listeners = this.listeners.get(id) ?? new Set()
    this.listeners.set(id, listeners)
    listeners.add(listener)
    listener(managed.state)
    return () => { listeners.delete(listener) }
  }

  /** The helper of a box has dialed in. */
  attachHelper(id: string, tunnel: AcceptedTunnel): void {
    this.find(id).managed.attach(helperLink(tunnel))
  }

  /** Whether the gateway knows a box. */
  hasBox(id: string): boolean {
    return this.boxes.has(id)
  }

  // The services.

  stage(request: StageServiceRequest): Promise<Spec> {
    return this.specs.stage(request)
  }

  /** Take in a package, which must have `digest`. */
  async upload(digest: string, archive: AsyncIterable<Uint8Array>): Promise<void> {
    if (await this.store.has(digest)) {
      // Read, so the uploader is not left waiting, and pass over.
      for await (const _ of archive) { /* the store has it */ }
      return
    }
    await this.store.receive(digest, archive)
  }

  /** The spec a tunnel names, checked as one a server may serve now. */
  async specForTunnel(name: string, digest: string): Promise<Spec> {
    const spec = await this.specs.get(digest)
    if (spec === undefined || spec.name !== name) throw unknownSpec(digest)
    if (spec.package !== '' && !(await this.store.has(spec.package))) throw noPackage(spec.package)
    return spec
  }

  /** The services registered now. */
  async services(): Promise<Service[]> {
    return await Promise.all(this.registrations.list().map(async ({ spec }) => create(ServiceSchema, {
      name: spec.name,
      description: spec.description,
      services: [...spec.services],
      commands: Object.keys(await this.specs.commands(spec)).sort(),
      env: { ...spec.env },
      spec: spec.digest,
    })))
  }

  /** Where a call to service `name` goes, from box `box` or a client: refused for a box that was not made with it. */
  serviceFor(name: string, box?: string): Registration {
    if (box !== undefined && !this.find(box).record.services.some(service => service.name === name)) throw noService(`${box} has no service ${name}`)
    const registration = this.registrations.get(name)
    if (registration === undefined) throw noService(`no service ${name} is registered now`)
    return registration
  }

  private keep(record: BoxRecord): { managed: ManagedBox; record: BoxRecord } {
    let contents: Promise<Contents> | undefined
    const managed = new ManagedBox({
      id: record.id,
      driver: this.deps.driver,
      platform: this.deps.platform,
      contents: () => {
        contents ??= this.contentsOf(record).catch((error: unknown) => {
          contents = undefined
          throw error
        })
        return contents
      },
      installed: () => kept.record.tree,
      keepInstalled: async (tree) => {
        const next: BoxRecord = { ...kept.record }
        if (tree === undefined) delete next.tree
        else next.tree = tree
        await this.registry.put(next)
        kept.record = next
      },
      onState: (state) => {
        for (const listener of this.listeners.get(record.id) ?? []) listener(state)
      },
    })
    const kept: { managed: ManagedBox; record: BoxRecord } = { managed, record }
    this.boxes.set(record.id, kept)
    return kept
  }

  private async contentsOf(record: BoxRecord): Promise<Contents> {
    const specs = await Promise.all(record.services.map(async ({ name, spec: digest }) => {
      const spec = await this.specs.get(digest)
      if (spec === undefined) throw new ConnectError(`fleet: the spec of ${record.id}'s service ${name} is gone from the gateway's home`, Code.DataLoss)
      return spec
    }))
    return await contentsOf(specs, { store: this.store, specs: this.specs, runtime: this.runtime })
  }

  private find(id: string): { managed: ManagedBox; record: BoxRecord } {
    const kept = this.boxes.get(id)
    if (kept === undefined) throw noBox(id)
    return kept
  }

  private infoOf({ managed, record }: { managed: ManagedBox; record: BoxRecord }): Box {
    return create(BoxSchema, {
      id: record.id,
      image: record.image,
      labels: record.labels,
      env: record.env,
      services: record.services.map(service => service.name),
      createdAt: timestampFromDate(new Date(record.createdAt)),
      state: managed.state,
    })
  }
}

