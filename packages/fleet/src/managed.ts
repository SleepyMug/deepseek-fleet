/**
 * One box as the gateway keeps it: its container, opened once, so that
 * its verbs run in order; its operations, one after another; whether it was
 * started here; what occupies it, and the stop of the box once nothing has
 * for a while; and what follows its state. A box whose container is gone is
 * `gone`, which its owner learns as it next uses it, and makes another.
 * @module @sleepymug/fleet/managed
 */

import { BOX_GONE, NOT_STARTED, type BoxState, type Occupant } from '@sleepymug/fleet-protocol/fleet'
import type { Box } from './box/box.ts'
import type { Platform } from './platform.ts'
import { messageOf } from './util/error.ts'
import { Queue } from './util/queue.ts'

/** What the gateway uses of a box's container. */
export type RunBox = Pick<Box, 'container' | 'start' | 'stop' | 'remove' | 'copyIn' | 'copyOut' | 'pipe' | 'request'>

/** Where the gateway gets the boxes' containers: Docker's, through `Box`, unless a test stands in. */
export interface Boxes {
  /** @param options.channel - the host folder of the box's channel, which the box has mounted. */
  create(name: string, options: { image: string; env: Readonly<Record<string, string>>; labels: Readonly<Record<string, string>>; channel: string }): Promise<RunBox>
  open(name: string): Promise<RunBox>
  /** Whether a container is there, and whether it runs. */
  state(name: string): Promise<'running' | 'stopped' | 'missing'>
}

/** A failure for a box whose container is gone, with {@link BOX_GONE} as its code. */
export class BoxGone extends Error {
  readonly code = BOX_GONE

  constructor(id: string) {
    super(`fleet: the container of ${id} is gone; make another box`)
  }
}

export interface ManagedDeps {
  id: string
  boxes: Boxes
  platform: Platform
  /** How long the box runs while nothing occupies it before it is stopped. */
  idleStopMs: number
  /** Readies a box whose helper just started, before anything else uses it, as by putting its services in. */
  onStarted: (box: RunBox) => Promise<void>
  /** Told each change of the box's state. */
  onState: (state: BoxState) => void
}

/** A box, held by an occupant until the release. */
export interface Held {
  box: RunBox
  release: () => void
}

export class ManagedBox {
  /** The container, opened the first time it is asked for. */
  private handle: Promise<RunBox> | undefined
  private current: BoxState = 'stopped'
  private readonly queue = new Queue()
  private readonly occupants = new Map<symbol, Occupant>()
  /** What cancels the pending stop of the idle box, which every vacancy arms again. */
  private cancelIdle: (() => void) | undefined
  /** To stop as soon as nothing occupies it. */
  private soon = false
  /** Running, as a gateway before this one left it, though not started here. */
  private adopted = false
  /** Removed, and forgotten. */
  private removed = false

  /** @param box - its container, just created, if it was. */
  constructor(private readonly deps: ManagedDeps, box?: RunBox) {
    if (box !== undefined) this.handle = Promise.resolve(box)
  }

  get state(): BoxState {
    return this.current
  }

  /** Run an operation on the box, after those before it; it is given what starts the box, if it is not. */
  exclusive<T>(operation: (running: () => Promise<RunBox>) => Promise<T>): Promise<T> {
    return this.queue.run(() => operation(() => this.running()))
  }

  /** The started box, occupied by `occupant` until the release. */
  async hold(occupant: Occupant): Promise<Held> {
    const release = this.occupy(occupant)
    try {
      return { box: await this.exclusive(running => running()), release }
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

  /** The box's container, started or not, as for a copy; in one of its operations, to keep their order. */
  container(): Promise<RunBox> {
    if (this.removed) return Promise.reject(new Error(`fleet: no box ${this.deps.id}`))
    return this.box()
  }

  /** The box, started; one that is not fails. */
  async started(): Promise<RunBox> {
    if (this.current !== 'started') throw Object.assign(new Error(`fleet: ${this.deps.id} is not started`), { code: NOT_STARTED })
    return await this.box()
  }

  /** Start the box, and a new helper in it, if it is not started. */
  async start(): Promise<void> {
    await this.exclusive(running => running())
    // Started for no one: it stops once it has been idle long enough.
    this.vacated()
  }

  /** Stop the box, which keeps what is in it, whatever occupies it. */
  async stop(): Promise<void> {
    await this.exclusive(async () => {
      if (this.removed) return
      this.setState('stopping')
      await (await this.box()).stop()
      this.adopted = false
      this.setState('stopped')
    })
  }

  /** Stop the box as soon as nothing occupies it: now, if nothing does; else once the last occupant leaves. */
  async stopWhenVacant(): Promise<void> {
    if (this.occupants.size > 0) {
      this.soon = true
      return
    }
    this.disarm()
    await this.exclusive(() => this.stopVacant(true))
  }

  /** A box a gateway before this one left running, which stops once it has been idle long enough, as one started here does. */
  adopt(): void {
    this.adopted = true
    this.vacated()
  }

  /** Remove the box, running or not, then `forget` it, in one of its operations; a container removed by other means is let be. */
  async remove(forget: () => Promise<void>): Promise<void> {
    await this.exclusive(async () => {
      if (this.removed) return
      try {
        await (await this.box()).remove()
      } catch (error) {
        if (await this.deps.boxes.state(this.deps.id) !== 'missing') throw error
      }
      await forget()
      this.removed = true
      this.handle = undefined
      this.occupants.clear()
      this.disarm()
      this.soon = false
    })
  }

  /** Stop the box, if it was started here, as the gateway closes. */
  async close(): Promise<void> {
    this.disarm()
    if (this.current !== 'started') return
    try {
      await (await this.box()).stop()
      this.setState('stopped')
    } catch (error) {
      this.deps.platform.log(`could not stop ${this.deps.id}: ${messageOf(error)}`)
    }
  }

  /** The box, started if it was not started here; a container that is gone fails. */
  private async running(): Promise<RunBox> {
    if (this.removed) throw new Error(`fleet: no box ${this.deps.id}`)
    if (this.current === 'started') return await this.box()
    if (await this.deps.boxes.state(this.deps.id) === 'missing') {
      this.handle = undefined
      this.setState('gone')
      throw new BoxGone(this.deps.id)
    }
    const box = await this.box()
    try {
      await box.start()
      await this.deps.onStarted(box)
    } catch (error) {
      await box.stop().catch(() => {})
      this.setState('stopped')
      throw error
    }
    this.adopted = false
    this.setState('started')
    return box
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
      this.exclusive(() => this.stopVacant(this.adopted)).catch((error: unknown) => {
        this.deps.platform.log(`could not stop the idle box ${this.deps.id}: ${messageOf(error)}`)
      })
    })
    this.cancelIdle = cancel
  }

  /**
   * Stop the box, in one of its operations, if nothing occupies it: one
   * started here, or, with `any`, one started by anyone, as by a gateway that
   * stopped before it was done with it.
   */
  private async stopVacant(any: boolean): Promise<void> {
    if (this.removed || this.occupants.size > 0) return
    if (!any && this.current !== 'started') return
    this.soon = false
    this.adopted = false
    this.setState('stopping')
    await (await this.box()).stop()
    this.setState('stopped')
  }

  /** Cancel the pending idle stop. */
  private disarm(): void {
    this.cancelIdle?.()
    this.cancelIdle = undefined
  }

  /** The container, opened the first time it is asked for; one that would not open is opened again the next time. */
  private box(): Promise<RunBox> {
    if (this.handle !== undefined) return this.handle
    const opening = this.deps.boxes.open(this.deps.id)
    this.handle = opening
    opening.catch(() => { if (this.handle === opening) this.handle = undefined })
    return opening
  }
}
