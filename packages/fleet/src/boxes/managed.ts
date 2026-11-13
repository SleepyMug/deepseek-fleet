/**
 * One box as the gateway keeps it: its container, through its driver; its
 * helper, once it dials in; its operations, one after another; what
 * occupies it, and its stop once nothing has for its idle time; and what
 * follows its state. A box is started once its container runs, its helper
 * has reached the gateway, and it holds its services' tree; a box whose
 * container is gone is `gone`, which its owner learns as it next uses it.
 * @module @sleepymug/fleet/boxes/managed
 */

import { setTimeout as delay } from 'node:timers/promises'
import { create } from '@bufbuild/protobuf'
import { BoxState } from '@sleepymug/fleet-protocol/gateway'
import { InstallRequestSchema } from '@sleepymug/fleet-protocol/box'
import { boxGone, noBox, notStarted } from '../failure.ts'
import type { Platform } from '../platform.ts'
import { messageOf } from '../util/error.ts'
import { Queue } from '../util/queue.ts'
import type { Contents } from './contents.ts'
import type { BoxDriver } from './driver.ts'
import type { HelperLink } from './link.ts'

/** How often a start that waits for the helper checks that the container still runs. */
const CHECK_MS = 500

export interface ManagedDeps {
  id: string
  driver: BoxDriver
  platform: Platform
  /** How long the box runs while nothing occupies it before it is stopped. */
  idleStopMs: number
  /** The tree of the box's services, which its helper installs as it first starts. */
  contents: () => Promise<Contents>
  /** Told each change of the box's state. */
  onState: (state: BoxState) => void
}

/** What occupies a box: its kind and its own id, both its holder's to choose. */
export interface Occupant {
  readonly kind: string
  readonly id: string
}

/** A box held by an occupant until the release. */
export interface Held {
  link: HelperLink
  release: () => void
}

export class ManagedBox {
  private current: BoxState = BoxState.STOPPED
  private link: HelperLink | undefined
  /** Waiting for the helper to dial in. */
  private readonly linked = new Set<(link: HelperLink) => void>()
  private readonly queue = new Queue()
  private readonly occupants = new Map<symbol, Occupant>()
  /** What cancels the pending stop of the idle box, which every vacancy arms again. */
  private cancelIdle: (() => void) | undefined
  /** To stop as soon as nothing occupies it. */
  private soon = false
  private removed = false

  constructor(private readonly deps: ManagedDeps) {}

  get id(): string {
    return this.deps.id
  }

  get state(): BoxState {
    return this.current
  }

  /** The helper, which has dialed in for this box: a start waiting for it has it; otherwise the box runs already, as a gateway before this one left it, and is taken as started once it holds its tree. */
  attach(link: HelperLink): void {
    if (this.removed) {
      link.close()
      return
    }
    this.link?.close()
    this.link = link
    void link.closed.then(() => { void this.detached(link) })
    const waiting = [...this.linked]
    this.linked.clear()
    for (const resolve of waiting) resolve(link)
    if (waiting.length === 0 && this.current !== BoxState.STARTING) {
      void this.queue.run(async () => {
        if (this.link !== link || this.current === BoxState.STARTED) return
        this.setState(BoxState.STARTING)
        try {
          await this.provision(link)
          this.setState(BoxState.STARTED)
          this.vacated()
        } catch (error) {
          this.deps.platform.log(`could not take ${this.deps.id} as started: ${messageOf(error)}`)
          link.close()
        }
      })
    }
  }

  /** The started box's helper, held by `occupant` until the release; the box started if it is not. */
  async hold(occupant: Occupant): Promise<Held> {
    const release = this.occupy(occupant)
    try {
      return { link: await this.queue.run(() => this.running()), release }
    } catch (error) {
      release()
      throw error
    }
  }

  /** Occupy the box until the returned release, which only the first call does, without starting it. */
  occupy(occupant: Occupant): () => void {
    const token = Symbol(occupant.id)
    this.occupants.set(token, occupant)
    this.disarm()
    return () => {
      if (!this.occupants.delete(token)) return
      this.vacated()
    }
  }

  /** What occupies the box now. */
  occupied(): Occupant[] {
    return [...this.occupants.values()]
  }

  /** The helper of the box, started; a box that is not started fails. */
  started(): HelperLink {
    if (this.removed) throw noBox(this.deps.id)
    if (this.current !== BoxState.STARTED || this.link === undefined) throw notStarted(this.deps.id)
    return this.link
  }

  /** Start the box, if it is not started, without occupying it. */
  async start(): Promise<void> {
    await this.queue.run(() => this.running())
    // Started for no one: it stops once it has been idle long enough.
    this.vacated()
  }

  /** Stop the box, whatever occupies it; what is in it stays. */
  async stop(): Promise<void> {
    await this.queue.run(() => this.halt())
  }

  /** Stop the box as soon as nothing occupies it: now, if nothing does; else once the last occupant leaves. */
  async stopWhenVacant(): Promise<void> {
    if (this.occupants.size > 0) {
      this.soon = true
      return
    }
    this.disarm()
    await this.queue.run(() => this.halt())
  }

  /** Remove the box, running or not, then `forget` it; a container removed by other means is let be. */
  async remove(forget: () => Promise<void>): Promise<void> {
    await this.queue.run(async () => {
      if (this.removed) return
      await this.deps.driver.remove(this.deps.id).catch(async (error: unknown) => {
        if (await this.deps.driver.state(this.deps.id) !== 'missing') throw error
      })
      await forget()
      this.removed = true
      this.link?.close()
      this.link = undefined
      this.occupants.clear()
      this.disarm()
    })
  }

  /** Whether the box is removed, and forgotten. */
  get isRemoved(): boolean {
    return this.removed
  }

  /** Stop the box, if it is started, as the gateway closes. */
  async close(): Promise<void> {
    this.disarm()
    if (this.current !== BoxState.STARTED && this.current !== BoxState.STARTING) return
    try {
      await this.deps.driver.stop(this.deps.id)
      this.setState(BoxState.STOPPED)
    } catch (error) {
      this.deps.platform.log(`could not stop ${this.deps.id}: ${messageOf(error)}`)
    }
  }

  /** The box's helper, the box started first if it is not: its container, its helper's dialing in, and its tree. */
  private async running(): Promise<HelperLink> {
    if (this.removed) throw noBox(this.deps.id)
    if (this.current === BoxState.STARTED && this.link !== undefined) return this.link
    const state = await this.deps.driver.state(this.deps.id)
    if (state === 'missing') {
      this.setState(BoxState.GONE)
      throw boxGone(this.deps.id)
    }
    this.setState(BoxState.STARTING)
    try {
      const dialed = this.link !== undefined ? Promise.resolve(this.link) : new Promise<HelperLink>((resolve) => { this.linked.add(resolve) })
      if (state !== 'running') await this.deps.driver.start(this.deps.id)
      const link = await this.helper(dialed)
      await this.provision(link)
      this.setState(BoxState.STARTED)
      return link
    } catch (error) {
      this.linked.clear()
      await this.deps.driver.stop(this.deps.id).catch(() => {})
      this.setState(BoxState.STOPPED)
      throw error
    }
  }

  /** The helper once it dials in; a container that stops before then fails the start. */
  private async helper(dialed: Promise<HelperLink>): Promise<HelperLink> {
    let waiting = true
    const exited = (async () => {
      while (waiting) {
        await delay(CHECK_MS)
        if (waiting && await this.deps.driver.state(this.deps.id) !== 'running') {
          throw new Error(`fleet: the container of ${this.deps.id} stopped before its helper reached the gateway`)
        }
      }
      return undefined as never
    })()
    try {
      return await Promise.race([dialed, exited])
    } finally {
      waiting = false
      exited.catch(() => {})
    }
  }

  /** Give the box its tree, unless it holds it already. */
  private async provision(link: HelperLink): Promise<void> {
    const contents = await this.deps.contents()
    const { digest } = await link.provision.installed({})
    if (digest === contents.digest) return
    async function* parts() {
      yield create(InstallRequestSchema, { part: { case: 'digest', value: contents.digest } })
      for await (const chunk of contents.archive()) yield create(InstallRequestSchema, { part: { case: 'chunk', value: chunk } })
    }
    await link.provision.install(parts())
  }

  /** Stop the box, in one of its operations. */
  private async halt(): Promise<void> {
    if (this.removed) return
    this.soon = false
    if (await this.deps.driver.state(this.deps.id) === 'missing') {
      this.setState(BoxState.GONE)
      return
    }
    this.setState(BoxState.STOPPING)
    await this.deps.driver.stop(this.deps.id)
    this.link?.close()
    this.link = undefined
    this.setState(BoxState.STOPPED)
  }

  /** The helper's tunnel closed: the box is stopped if its container is, and else waits for its helper to dial in again. */
  private async detached(link: HelperLink): Promise<void> {
    if (this.link !== link) return
    this.link = undefined
    if (this.removed || this.current !== BoxState.STARTED) return
    const state = await this.deps.driver.state(this.deps.id).catch(() => 'running' as const)
    if (this.link !== undefined || this.current !== BoxState.STARTED) return
    if (state === 'missing') this.setState(BoxState.GONE)
    else if (state === 'stopped') this.setState(BoxState.STOPPED)
  }

  private setState(state: BoxState): void {
    if (this.current === state) return
    this.current = state
    this.deps.onState(state)
  }

  /** The box may have lost its last occupant: stop it once it has been idle long enough, or at once if asked to. */
  private vacated(): void {
    if (this.occupants.size > 0 || this.removed) return
    this.disarm()
    const cancel = this.deps.platform.after(this.soon ? 0 : this.deps.idleStopMs, () => {
      if (this.cancelIdle === cancel) this.cancelIdle = undefined
      this.queue.run(async () => {
        if (this.occupants.size > 0 || this.current !== BoxState.STARTED) return
        await this.halt()
      }).catch((error: unknown) => {
        this.deps.platform.log(`could not stop the idle box ${this.deps.id}: ${messageOf(error)}`)
      })
    })
    this.cancelIdle = cancel
  }

  private disarm(): void {
    this.cancelIdle?.()
    this.cancelIdle = undefined
  }
}
