/**
 * The box of one tau's session (./runs.ts), as fleet's gateway keeps it,
 * and when it runs, which is the session's to say, not the gateway's: the
 * box's id, which a box set up again changes; the session's operations on
 * it, one after another; what occupies it, each a turn, a call, a process
 * or a terminal of the session's; its state, which the gateway tells; the
 * host files copied into it; and whether it is removed while its session is
 * archived. The box is started as something holds it, and stopped once it
 * is started and nothing has occupied it for the idle time, or at once
 * after its run ended, whoever started it: the session, the `fleet`
 * command, or a dsh before this one. A box the gateway says is gone, or does not know, is set up again on its
 * next use, as the runs do it, from the run's call.
 * @module @sleepymug/dsh-tau/tau/session-box
 */

import { posix } from 'node:path'
import { pathEntry, writeTar } from '@sleepymug/fleet-pack'
import { Reason, reasonOf } from '@sleepymug/fleet-sdk'
import type { Platform } from '../platform.ts'
import { messageOf } from '../util/error.ts'
import { Queue } from '../util/queue.ts'
import type { BoxState, FleetBoxPort, FleetPort, Held, Occupant, RunBox } from './ports.ts'

export interface SessionBoxDeps {
  sessionId: string
  /** The box's id, as the session's entry has it. */
  box: string
  fleet: FleetPort
  platform: Platform
  /** How long the box runs, started, while nothing occupies it, before it is stopped. */
  idleStopMs: number
  /**
   * Set the box up again from the run's call, the box the gateway knew gone,
   * and give back the new one's id, started; the entry records it.
   */
  rebuild: () => Promise<string>
}

export class SessionBox {
  private id: string
  private readonly queue = new Queue()
  /** The host files copied in, or on their way, by their place in the box. */
  private readonly copies = new Map<string, Promise<void>>()
  /** What occupies the box now. */
  private readonly occupants = new Map<symbol, Occupant>()
  /** What cancels the stop of the idle box, while one is due. */
  private cancelIdle: (() => void) | undefined
  /** The stop of the idle box, while it is under way. */
  private stopping: Promise<void> | undefined
  /** The run ended: the box, as it runs then, stops as soon as nothing occupies it. */
  private ended = false
  /** Removed while the session is archived. */
  private archived = false
  /** The session was released, and the box with it. */
  private gone = false
  /** The box's state, as the gateway last told it; unknown until it tells. */
  private state: BoxState | 'removed' | undefined
  private unwatch: (() => void) | undefined
  /** What waits for the box to be started, to wake as it is. */
  private readonly waiters = new Set<() => void>()

  constructor(private readonly deps: SessionBoxDeps) {
    this.id = deps.box
  }

  /** The box's id now. */
  get box(): string {
    return this.id
  }

  /**
   * Follow the box's state from now on, so that a box started, by whoever,
   * is stopped once it is idle.
   */
  follow(): void {
    if (this.unwatch !== undefined || this.gone) return
    this.unwatch = this.deps.fleet.box(this.id).watch((state) => {
      this.state = state
      // Once stopped, by whoever, it is used afresh, and idles for the idle time.
      if (state === 'stopped') this.ended = false
      if (state === 'started' || state === 'removed') this.wake()
      this.settle()
    })
  }

  /**
   * Run an operation on the box, after those before it.
   * @param operation - is given the box, started if need be, or set up again, if gone, which only it may ask for.
   */
  exclusive<T>(operation: (running: () => Promise<FleetBoxPort>) => Promise<T>): Promise<T> {
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
      const box = await this.exclusive(async running => (this.gone ? undefined : await running()))
      if (box === undefined) {
        release()
        return undefined
      }
      return { box: runBox(box), release }
    } catch (error) {
      release()
      throw error
    }
  }

  /** Occupy the box, without starting it, until the returned release, which only the first call does. */
  occupy(occupant: Occupant): () => void {
    if (this.gone || this.archived) return () => {}
    const token = Symbol(occupant.id)
    this.occupants.set(token, occupant)
    this.settle()
    return () => {
      if (this.occupants.delete(token)) this.settle()
    }
  }

  /** Whether the box is started, as the gateway last told it. */
  isStarted(): boolean {
    this.follow()
    return this.state === 'started'
  }

  isArchived(): boolean {
    return this.archived
  }

  /** The box once it is started, now or whenever something next starts it; it fails once the session is gone, or the signal aborts. */
  async whenStarted(signal: AbortSignal): Promise<RunBox> {
    this.follow()
    for (;;) {
      signal.throwIfAborted()
      if (this.gone) throw this.unknown()
      if (this.state === 'started') return runBox(this.deps.fleet.box(this.id))
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
      const entry = await pathEntry(from, posix.basename(to))
      if (entry?.type !== 'file') throw new Error(`${from} is not a file`)
      await box.put(writeTar([{ ...entry, mode: 0o444 }]), posix.dirname(to))
    })
    this.copies.set(to, copying)
    copying.catch((error: unknown) => {
      if (this.copies.get(to) === copying) this.copies.delete(to)
      this.deps.platform.log(`could not copy ${from} into the box of ${this.deps.sessionId}: ${messageOf(error)}`)
    })
  }

  /** Start the box, set up again if it is gone. */
  async start(): Promise<void> {
    await this.exclusive(async (running) => {
      if (this.gone) throw this.unknown()
      await running()
    })
  }

  /** Stop the box, which keeps what is in it. */
  async stop(): Promise<void> {
    await this.exclusive(() => this.halt())
  }

  /** The run ended: stop the box as soon as nothing occupies it; it settles once it is stopped, if nothing does now. */
  async runEnded(): Promise<void> {
    this.ended = true
    this.settle()
    await this.stopping
  }

  /**
   * Remove the box, running or not, while the session is archived, until
   * {@link unarchive}, after which it is set up again on its next use; a box
   * that is gone is let be.
   */
  async archive(): Promise<void> {
    this.archived = true
    this.disarm()
    await this.exclusive(async () => {
      if (this.gone || !this.archived) return
      if (await removed(this.deps.fleet.box(this.id))) this.deps.platform.log(`removed the box ${this.id} of ${this.deps.sessionId}, which is archived`)
      this.copies.clear()
    })
  }

  unarchive(): void {
    this.archived = false
  }

  /**
   * Remove the box, running or not, then `forget` the session, in one of
   * its operations; the box is gone after, and what waits for it wakes. A
   * box removed by other means is let be.
   */
  async remove(forget: () => Promise<void>): Promise<void> {
    await this.exclusive(async () => {
      if (this.gone) throw this.unknown()
      await removed(this.deps.fleet.box(this.id))
      await forget()
      this.gone = true
      this.copies.clear()
      this.archived = false
      this.disarm()
      this.unwatch?.()
      this.unwatch = undefined
      this.wake()
    })
  }

  /** Stop following the box, and stop it if it is started, as the runs close: nothing of the session's uses it after. */
  async close(): Promise<void> {
    this.disarm()
    this.unwatch?.()
    this.unwatch = undefined
    if (this.state !== 'started' || this.gone) return
    await this.exclusive(() => this.halt())
  }

  /** The box, started, in one of its operations, set up again if the gateway knows it gone; none while it is archived. */
  private async running(): Promise<FleetBoxPort> {
    if (this.archived) throw new Error(`dsh-tau: ${this.deps.sessionId} is archived, so it has no box; unarchive it to have one again`)
    const box = this.deps.fleet.box(this.id)
    try {
      await box.start()
      return box
    } catch (error) {
      const reason = reasonOf(error)
      if (reason !== Reason.BOX_GONE && reason !== Reason.NO_BOX) throw error
    }
    this.copies.clear()
    this.id = await this.deps.rebuild()
    this.restartFollowing()
    return this.deps.fleet.box(this.id)
  }

  /** Stop the box, in one of its operations; one the gateway knows gone, or no longer, is let be. */
  private async halt(): Promise<void> {
    try {
      await this.deps.fleet.box(this.id).stop()
    } catch (error) {
      const reason = reasonOf(error)
      if (reason !== Reason.BOX_GONE && reason !== Reason.NO_BOX) throw error
    }
    // Stopped, as the gateway tells next: so nothing stops it again before it does.
    if (this.state === 'started') this.state = 'stopped'
    this.ended = false
  }

  /**
   * Have the idle box stopped, and only it: one that is started, which
   * nothing occupies, after the idle time, or at once once its run ended.
   * Whatever else it is, no stop is due.
   */
  private settle(): void {
    const idle = this.state === 'started' && this.occupants.size === 0 && !this.gone && !this.archived
    if (!idle || this.ended) this.disarm()
    if (!idle) return
    if (this.ended) {
      this.stopIdle()
      return
    }
    if (this.cancelIdle !== undefined) return
    const cancel = this.deps.platform.after(this.deps.idleStopMs, () => {
      if (this.cancelIdle === cancel) this.cancelIdle = undefined
      this.stopIdle()
    })
    this.cancelIdle = cancel
  }

  /** Stop the idle box, once, in one of its operations, unless something took it, or stopped it, meanwhile. */
  private stopIdle(): void {
    this.stopping ??= this.queue.run(async () => {
      if (this.occupants.size > 0 || this.state !== 'started' || this.gone || this.archived) return
      await this.halt()
    }).catch((error: unknown) => {
      this.deps.platform.log(`could not stop the idle box of ${this.deps.sessionId}: ${messageOf(error)}`)
    }).finally(() => {
      this.stopping = undefined
    })
  }

  private disarm(): void {
    this.cancelIdle?.()
    this.cancelIdle = undefined
  }

  /** Follow the box that took the place of one gone. */
  private restartFollowing(): void {
    this.unwatch?.()
    this.unwatch = undefined
    this.state = undefined
    this.follow()
  }

  /** Wake what waits for the box to be started, or for the session to go. */
  private wake(): void {
    for (const resolve of this.waiters) resolve()
  }

  private unknown(): Error {
    return new Error(`dsh-tau: no tau session ${this.deps.sessionId}`)
  }
}

/** A box as the world uses it: its id and its API, of the box started, which the world's holds keep so. */
export function runBox(port: FleetBoxPort): RunBox {
  return { id: port.id, api: port.api }
}

/** Remove a box, unless the gateway has forgotten it already; whether it removed it. */
async function removed(box: FleetBoxPort): Promise<boolean> {
  try {
    await box.remove()
    return true
  } catch (error) {
    if (reasonOf(error) === Reason.NO_BOX) return false
    throw error
  }
}
