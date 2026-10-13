/**
 * The box of one tau's session (./runs.ts): its container, opened once, so
 * that its verbs run in order; its operations, one after another; whether
 * it was started here; what occupies it, and the stop of the box once
 * nothing has for a while; what waits for it to start; the host files
 * copied into it; and whether it is removed while its session is archived.
 * A box whose container is gone is set up again on its next use, as the
 * runs do it, from the run's call.
 * @module @sleepymug/fleet-core/tau/session-box
 */

import { posix } from 'node:path'
import { Box, exec } from '../box/box.ts'
import type { CallHandler } from '../box/helper.ts'
import type { Platform } from '../platform.ts'
import { messageOf } from '../util/error.ts'
import { Queue } from '../util/queue.ts'
import type { Held, Occupant, RunBox } from './ports.ts'

/** Where the runs get their boxes: Docker's, through `Box`, unless a test stands in. */
export interface Boxes {
  create(name: string): Promise<RunBox>
  open(name: string): Promise<RunBox>
  /** Whether a box's container is there. */
  exists(name: string): Promise<boolean>
}

export const dockerBoxes: Boxes = {
  create: name => Box.create({ name }),
  open: name => Box.open(name),
  exists: async name => (await Box.list()).some(box => box.name === name),
}

export interface SessionBoxDeps {
  sessionId: string
  /** The container's name, which the box keeps when it is set up again. */
  container: string
  boxes: Boxes
  platform: Platform
  /** How long the box runs while nothing occupies it before it is stopped. */
  idleStopMs: number
  /** What answers the calls of the clients in the box. */
  calls: CallHandler
  /** Set the box up again from the run's call, its container gone, and give it back started. */
  rebuild: () => Promise<RunBox>
}

export class SessionBox {
  /** The container, opened the first time it is asked for. */
  private handle: Promise<RunBox> | undefined
  /** Started here, and not stopping, which {@link close} stops. */
  private started = false
  private readonly queue = new Queue()
  /** The host files copied in, or on their way, by their place in the box. */
  private readonly copies = new Map<string, Promise<void>>()
  /** Removed while the session is archived. */
  private archived = false
  private readonly occupants = new Map<symbol, Occupant>()
  /** What cancels the pending stop of the idle box, which every vacancy arms again. */
  private cancelIdle: (() => void) | undefined
  /** To stop as soon as nothing occupies it, as after its run ended. */
  private soon = false
  /** What waits for the box to be started, to wake as it is. */
  private readonly waiters = new Set<() => void>()
  /** The session was released, and the box with it. */
  private gone = false

  /** @param box - its container, just created, if it was. */
  constructor(private readonly deps: SessionBoxDeps, box?: RunBox) {
    if (box !== undefined) this.handle = Promise.resolve(box)
  }

  /**
   * Run an operation on the box, after those before it.
   * @param operation - is given what starts the box, if it is not, or sets it up again, if it is gone, which only it may call.
   */
  exclusive<T>(operation: (running: () => Promise<RunBox>) => Promise<T>): Promise<T> {
    return this.queue.run(() => operation(() => this.running()))
  }

  /**
   * The started box, occupied by `occupant` until the release; undefined,
   * occupying nothing, once the session is gone.
   */
  async hold(occupant: Occupant): Promise<Held | undefined> {
    if (this.gone) return undefined
    const release = this.occupy(occupant)
    try {
      const box = await this.exclusive(async running => this.gone ? undefined : running())
      if (box === undefined) release()
      return box === undefined ? undefined : { box, release }
    } catch (error) {
      release()
      throw error
    }
  }

  /** Occupy the box until the returned release, which only the first call does. */
  occupy(occupant: Occupant): () => void {
    const token = Symbol(occupant.id)
    this.occupants.set(token, occupant)
    this.disarm()
    return () => {
      if (!this.occupants.delete(token)) return
      this.vacated()
    }
  }

  isStarted(): boolean {
    return this.started
  }

  isArchived(): boolean {
    return this.archived
  }

  /** What occupies the box now. */
  occupied(): Occupant[] {
    return [...this.occupants.values()]
  }

  /** The box once it is started, now or whenever something next starts it; it fails once the session is gone, or the signal aborts. */
  async whenStarted(signal: AbortSignal): Promise<RunBox> {
    for (;;) {
      signal.throwIfAborted()
      if (this.gone) throw this.unknown()
      if (this.started) return await this.box()
      const woken = Promise.withResolvers<void>()
      const wake = (): void => { woken.resolve() }
      this.waiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
      try {
        await woken.promise
      } finally {
        this.waiters.delete(wake)
        signal.removeEventListener('abort', wake)
      }
    }
  }

  /**
   * Copy a host file into the box, at `to`, readable by all and writable by
   * none, once: asked again for the same place, it does nothing, unless the
   * copy failed, which it logs. It answers at once, and copies in turn with
   * the box's other operations.
   */
  copyInOnce(from: string, to: string): void {
    if (this.gone || this.copies.has(to)) return
    const copying = this.exclusive(async (running) => {
      if (this.gone) return
      const box = await running()
      await exec(box, ['mkdir', '-p', posix.dirname(to)])
      await box.copyIn(from, to)
      await exec(box, ['chmod', 'a=r', to])
    })
    this.copies.set(to, copying)
    copying.catch((error: unknown) => {
      if (this.copies.get(to) === copying) this.copies.delete(to)
      this.deps.platform.log(`could not copy ${from} into the box of ${this.deps.sessionId}: ${messageOf(error)}`)
    })
  }

  /** Start the box, and a new helper in it. */
  async start(): Promise<void> {
    await this.exclusive(async () => {
      if (this.gone) throw this.unknown()
      await (await this.box()).start(this.deps.calls)
      this.markStarted()
    })
  }

  /** Stop the box, which keeps what is in it. */
  async stop(): Promise<void> {
    await this.exclusive(async () => {
      // Not started from here on, so what its stop ends knows the box is stopping (../world/fs.ts).
      this.started = false
      await (await this.box()).stop()
    })
  }

  /** Stop the box as soon as nothing occupies it: now, if nothing does, as when its run ended; else once the last occupant leaves. */
  async stopWhenVacant(): Promise<void> {
    if (this.occupants.size > 0) {
      this.soon = true
      return
    }
    this.disarm()
    await this.exclusive(() => this.stopVacant(true))
  }

  /**
   * Remove the box, running or not, while the session is archived, until
   * {@link unarchive}, after which it is set up again on its next use; a
   * container that is gone is let be.
   */
  async archive(): Promise<void> {
    this.archived = true
    await this.exclusive(async () => {
      if (this.gone || !this.archived) return
      const { container, boxes, platform, sessionId } = this.deps
      if (await boxes.exists(container)) {
        await (await this.box()).remove()
        platform.log(`removed the box ${container} of ${sessionId}, which is archived`)
      }
      this.handle = undefined
      this.started = false
      this.copies.clear()
      this.disarm()
      this.soon = false
    })
  }

  unarchive(): void {
    this.archived = false
  }

  /**
   * Remove the box, running or not, then `forget` the session, in one of
   * its operations; the box is gone after, and what waits for it wakes. A
   * container removed by other means is let be.
   */
  async remove(forget: () => Promise<void>): Promise<void> {
    await this.exclusive(async () => {
      if (this.gone) throw this.unknown()
      try {
        await (await this.box()).remove()
      } catch (error) {
        if (await this.deps.boxes.exists(this.deps.container)) throw error
      }
      await forget()
      this.gone = true
      this.handle = undefined
      this.started = false
      this.copies.clear()
      this.archived = false
      this.occupants.clear()
      this.disarm()
      this.soon = false
      this.wake()
    })
  }

  /** Stop the box, if it was started here. */
  async close(): Promise<void> {
    this.disarm()
    if (!this.started) return
    this.started = false
    try {
      await (await this.box()).stop()
    } catch (error) {
      this.deps.platform.log(`could not stop the box of ${this.deps.sessionId}: ${messageOf(error)}`)
    }
  }

  /**
   * The box, started if it was not started here, and set up again if it is
   * gone, in one of its operations; none while it is archived.
   */
  private async running(): Promise<RunBox> {
    if (this.archived) throw new Error(`fleet: ${this.deps.sessionId} is archived, so it has no box; unarchive it to have one again`)
    if (this.started) return await this.box()
    if (!await this.deps.boxes.exists(this.deps.container)) {
      this.handle = undefined
      const box = await this.deps.rebuild()
      this.handle = Promise.resolve(box)
      this.markStarted()
      return box
    }
    const box = await this.box()
    await box.start(this.deps.calls)
    this.markStarted()
    return box
  }

  private markStarted(): void {
    this.started = true
    this.wake()
  }

  /** The box may have lost its last occupant: stop it once it has been idle long enough, or at once if asked to. */
  private vacated(): void {
    if (this.occupants.size > 0 || this.gone) return
    this.disarm()
    const cancel = this.deps.platform.after(this.soon ? 0 : this.deps.idleStopMs, () => {
      if (this.cancelIdle === cancel) this.cancelIdle = undefined
      this.exclusive(() => this.stopVacant(false)).catch((error: unknown) => {
        this.deps.platform.log(`could not stop the idle box of ${this.deps.sessionId}: ${messageOf(error)}`)
      })
    })
    this.cancelIdle = cancel
  }

  /**
   * Stop the box, in one of its operations, if nothing occupies it: one
   * started here, or, with `any`, one started by anyone, as by a dsh that
   * stopped before its run ended.
   */
  private async stopVacant(any: boolean): Promise<void> {
    if (this.gone || this.archived || this.occupants.size > 0) return
    if (!any && !this.started) return
    this.soon = false
    this.started = false
    await (await this.box()).stop()
  }

  /** Cancel the pending idle stop. */
  private disarm(): void {
    this.cancelIdle?.()
    this.cancelIdle = undefined
  }

  /** Wake what waits for the box to be started, or for the session to go. */
  private wake(): void {
    for (const resolve of this.waiters) resolve()
  }

  /** The container, opened the first time it is asked for; one that would not open is opened again the next time. */
  private box(): Promise<RunBox> {
    if (this.handle !== undefined) return this.handle
    const opening = this.deps.boxes.open(this.deps.container)
    this.handle = opening
    opening.catch(() => { if (this.handle === opening) this.handle = undefined })
    return opening
  }

  private unknown(): Error {
    return new Error(`fleet: no tau session ${this.deps.sessionId}`)
  }
}
