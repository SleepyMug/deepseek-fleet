/**
 * The box of one tau's session (./runs.ts), as fleet's gateway keeps it: the
 * box's id, which a box set up again changes; the session's operations on
 * it, one after another; its leases, each of an occupant, which keep the
 * gateway from stopping it for being idle; its state, which the gateway
 * tells; the host files copied into it; and whether it is removed while its
 * session is archived. A box the gateway says is gone, or does not know, is set
 * up again on its next use, as the runs do it, from the run's call.
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
    return await this.exclusive(async () => {
      if (this.gone) return undefined
      this.ready()
      const box = await this.held(occupant)
      return { box: runBox(box.port), release: () => { void box.release() } }
    })
  }

  /** Occupy the box, without starting it, until the returned release, which only the first call does. */
  occupy(occupant: Occupant): () => void {
    if (this.gone || this.archived) return () => {}
    let released = false
    const leased = this.deps.fleet.box(this.id).lease(occupant, { start: false }).catch(() => undefined)
    return () => {
      if (released) return
      released = true
      void leased.then(release => release?.())
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
    await this.exclusive(async () => {
      await this.deps.fleet.box(this.id).stop()
    })
  }

  /** Stop the box as soon as nothing occupies it: now, if nothing does, as when its run ended; else once the last occupant leaves. */
  async stopWhenVacant(): Promise<void> {
    await this.deps.fleet.box(this.id).stopWhenVacant()
  }

  /**
   * Remove the box, running or not, while the session is archived, until
   * {@link unarchive}, after which it is set up again on its next use; a box
   * that is gone is let be.
   */
  async archive(): Promise<void> {
    this.archived = true
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
      this.unwatch?.()
      this.unwatch = undefined
      this.wake()
    })
  }

  /** Stop following the box's state, as the runs close. */
  close(): void {
    this.unwatch?.()
    this.unwatch = undefined
  }

  /** The box, started, in one of its operations, set up again if it is gone; none while it is archived. */
  private async running(): Promise<FleetBoxPort> {
    const { port, release } = await this.held({ kind: 'call', id: 'start' })
    await release()
    return port
  }

  /** A lease of the box, started, set up again if the gateway knows it gone. */
  private async held(occupant: Occupant): Promise<{ port: FleetBoxPort; release: () => Promise<void> }> {
    if (this.archived) throw new Error(`dsh-tau: ${this.deps.sessionId} is archived, so it has no box; unarchive it to have one again`)
    let port = this.deps.fleet.box(this.id)
    try {
      return { port, release: await port.lease(occupant) }
    } catch (error) {
      const reason = reasonOf(error)
      if (reason !== Reason.BOX_GONE && reason !== Reason.NO_BOX) throw error
    }
    this.copies.clear()
    this.id = await this.deps.rebuild()
    this.restartFollowing()
    port = this.deps.fleet.box(this.id)
    return { port, release: await port.lease(occupant) }
  }

  /** Follow the box's state, if not yet. */
  private follow(): void {
    if (this.unwatch !== undefined || this.gone) return
    this.unwatch = this.deps.fleet.box(this.id).watch((state) => {
      this.state = state
      if (state === 'started' || state === 'removed') this.wake()
    })
  }

  /** Follow the box that took the place of one gone. */
  private restartFollowing(): void {
    if (this.unwatch === undefined) return
    this.unwatch()
    this.unwatch = undefined
    this.state = undefined
    this.follow()
  }

  /** Follow the box from its first use on. */
  private ready(): void {
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

/** A box as the world uses it: its API, of the box started, which the world's own leases hold. */
export function runBox(port: FleetBoxPort): RunBox {
  return { id: port.id, api: port.started }
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
