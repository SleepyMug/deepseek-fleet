/**
 * What the runs of taus (./runs.ts) give those that build on them, each
 * as much as it uses: the world, the `tau` preset's plugins and `tau_run`,
 * which ask which sessions are a tau's and use their boxes
 * ({@link TauBoxes}); and the tau backend, which submits, watches,
 * finishes and releases runs ({@link RunLifecycle}); and what the runs
 * build on of fleet's gateway ({@link FleetPort}), fleet-sdk's, as a test
 * stands in for it.
 * @module @sleepymug/dsh-tau/tau/ports
 */

import type { Client } from '@connectrpc/connect'
import type { Box } from '@sleepymug/fleet-protocol/box'
import type { Outcome } from '@sleepymug/tau/core'
import type { Caller, Entry } from './registry.ts'

/** A box's API, `fleet.box.v1.Box`, as a Connect client. */
export type BoxApi = Client<typeof Box>

/** What a run's box is made with. */
export interface BoxSpec {
  labels: Record<string, string>
  env: Record<string, string>
  /** The services it has, fixed once it is made. */
  services: string[]
  image?: string
}

/** A service registered with the gateway, as a tau's session's prompt tells of it. */
export interface ServiceInfo {
  name: string
  description: string
  /** Its package's commands, on the PATH in a box that has it, each with what it does, if the service says. */
  commands: { name: string; description: string }[]
}

/** What the runs use of fleet's gateway: its boxes. */
export interface FleetPort {
  /** Make a box, stopped, and give its id. */
  create(spec: BoxSpec): Promise<string>
  /** Every box the gateway keeps, by its id, with its labels. */
  list(): Promise<{ id: string; labels: Record<string, string> }[]>
  box(id: string): FleetBoxPort
  /** The services registered now, which a run's box is made with. */
  services(): Promise<ServiceInfo[]>
}

/** A box of the gateway's, as fleet-sdk's `FleetBox` is. */
export interface FleetBoxPort {
  readonly id: string
  /** Its API, of the box started; a call of a box that is not fails, `NOT_STARTED`. */
  readonly api: BoxApi
  /** The services it was made with. */
  services(): Promise<string[]>
  /** Follow its state, until the returned stop. */
  watch(listener: (state: BoxState | 'removed') => void): () => void
  /** Start it, if it is not started: it runs until it is stopped. */
  start(): Promise<void>
  stop(): Promise<void>
  remove(): Promise<void>
  /** Unpack a tar archive into a folder of the box's. */
  put(archive: AsyncIterable<Uint8Array>, to: string): Promise<void>
  /** A folder's contents, or a file under its own name, as a tar archive. */
  get(from: string): AsyncIterable<Uint8Array>
}

/** A box's state, as the gateway tells it. */
export type BoxState = 'stopped' | 'starting' | 'started' | 'stopping' | 'gone'

/** A session's box, as the world asks of it: its API, of the box started, which a call does not start. */
export interface RunBox {
  /** Its id, the gateway's. */
  readonly id: string
  readonly api: BoxApi
}

/** Something that needs a session's box running now. */
export interface Occupant {
  /**
   * `turn`: the session's agent is running.
   * `terminal`: a user's shell, until it ends.
   * `process`: a process in the box, until it exits.
   * `call`: a request to the box's helper for a caller, while it runs.
   * `file`: a file call served from the box, while it runs.
   */
  kind: 'turn' | 'terminal' | 'process' | 'call' | 'file'
  /** The agent's, terminal's, process's or call's own id. */
  id: string
}

/** A session's box, held by an occupant until the release. */
export interface Held {
  box: RunBox
  release: () => void
}

/** What a submit says of its run, besides the call. */
export interface About {
  /** What names the run, in `list` and dsh's web UI. */
  title: string
  /** The caller's folder, absolute, unless it is a tau's session, whose runs are in its own project. */
  project?: string
}

/** A run set up. */
export interface Started {
  /** The session the run is, minted here, which is the run's id. */
  sessionId: string
  /** The box's id, the gateway's. */
  box: string
  /** The tau's prompt, expanded with where the box has each file. */
  prompt: string
}

/** How a run's init ended (./init.ts). */
export interface InitEnd {
  /** Its exit code, or null when a signal killed it. */
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

/** Which sessions are a tau's, and their boxes, as the world and the `tau` preset's plugins use them. */
export interface TauBoxes {
  /** Whether a session is a tau's, at once, so that a caller that cannot wait, such as a process's start, can ask. */
  isTau(sessionId: string): boolean
  /** The services of a tau's session's box, each as registered now, with its commands. */
  services(sessionId: string): Promise<ServiceInfo[]>
  /** A tau's session's registry entry; a session that is not a tau's fails. */
  entry(sessionId: string): Promise<Entry>
  /**
   * Where a path of a tau's session's work is in its box: a path in its
   * project is in its working directory there, and any other is as it is.
   * A session that is not a tau's keeps its paths.
   */
  boxPath(sessionId: string, path: string): string
  /**
   * The started box of a tau's session, started if it is not, and set up
   * again from the run's call if it is gone; or undefined for a session that
   * is not a tau's. While the session is archived, it fails.
   */
  boxFor(sessionId: string): Promise<RunBox | undefined>
  /**
   * The box of a tau's session, as {@link boxFor} gives it, occupied by
   * `occupant` from before it is asked for until the release, so it is not
   * stopped for being idle under it; or undefined, occupying nothing, for a
   * session that is not a tau's.
   */
  hold(sessionId: string, occupant: Occupant): Promise<Held | undefined>
  /**
   * Occupy a session's box: it is not stopped for being idle until the
   * returned release, which only the first call does. Occupy before asking
   * for the box.
   */
  occupy(sessionId: string, occupant: Occupant): () => void
  /** Whether a session's box is started here, and not stopping. */
  isStarted(sessionId: string): boolean
  /**
   * A session's box once it is started, now or whenever something next
   * starts it; this starts nothing. It fails once the session is gone, or
   * the signal aborts.
   */
  whenStarted(sessionId: string, signal: AbortSignal): Promise<RunBox>
  /**
   * Copy a host file into the box of a tau's session, at `to`, readable by
   * all and writable by none, once, before the box's next use; a session
   * that is not a tau's is ignored.
   */
  copyInOnce(sessionId: string, from: string, to: string): void
}

/** The runs, as the tau backend starts, watches, finishes and releases them. */
export interface RunLifecycle {
  /** Whether a session is a tau's: one the runs have, not released. */
  isTau(sessionId: string): boolean
  /** The tau's session whose box `box` is, the gateway's id of it; undefined for a box that is no run's. */
  sessionOfBox(box: string): string | undefined
  /** A session's registry entry; a session that is not a tau's fails. */
  entry(sessionId: string): Promise<Entry>
  /** Every session's registry entry, oldest first. */
  list(): Promise<Entry[]>
  /** Admit a call, and set up a box for its run, stopped, and register the session. */
  create(call: AsyncIterable<Uint8Array>, about: About, caller?: Caller): Promise<Started>
  /** Start a session's box. */
  start(sessionId: string): Promise<void>
  /** Run a session's init in its box; the signal ends it. */
  init(sessionId: string, signal: AbortSignal): Promise<InitEnd>
  /** Record that a session was given its prompt. */
  prompted(sessionId: string): Promise<void>
  /** Keep the result of a session's run, which ended as `outcome` says, and give back how it ended, as the result has it. */
  pack(sessionId: string, outcome: Outcome): Promise<Outcome>
  /** Record that a session's run ended, and how. */
  ended(sessionId: string, result: Outcome): Promise<void>
  /** The result of a session's run that ended, as {@link pack} kept it. */
  result(sessionId: string): Promise<AsyncIterable<Uint8Array>>
  /** Record that a session's run's result was first given back. */
  finished(sessionId: string): Promise<void>
  /** A session's run ended: stop its box as soon as nothing occupies it, settling once it is stopped, if nothing does now. */
  runEnded(sessionId: string): Promise<void>
  /** Remove a session's box while the session is archived, keeping its entry and result. */
  archive(sessionId: string): Promise<void>
  /** Let a session that is no longer archived have a box again. */
  unarchive(sessionId: string): void
  /** Whether a session's box is removed while it is archived. */
  isArchived(sessionId: string): boolean
  /** Remove a session's box, its registry entry and its folder. */
  remove(sessionId: string): Promise<void>
}
