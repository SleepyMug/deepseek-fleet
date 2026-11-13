/**
 * The wire between the gateway and its clients, harnesses and fleet servers:
 * the gateway's socket, a Unix socket only its owner can open, which is its
 * authentication. A client opens one connection, says the wire's version,
 * and sends requests on it, one JSON message a line, each with an id of the
 * client's; the gateway answers each once, in any order, with events before
 * the answer for an op that sends them. What a client holds, its leases and
 * the services it registered, it holds while its connection lasts. Shared by
 * both ends, so it holds only types and constants.
 *
 * A service the client registers is a socket of its own, its endpoint, to
 * which the gateway opens a connection for each one a program in a box opens to
 * the service's socket there, says first, in a line of JSON, which box it
 * comes from ({@link Preamble}), then passes the bytes both ways.
 * @module @sleepymug/fleet-protocol/fleet
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Method, Methods } from './helper.ts'

/** The wire's version, which a client says first, and the gateway checks. */
export const FLEET_PROTOCOL = 1

/** The gateway's home, the fleet home: `$FLEET_HOME`, or `~/.fleet`. */
export function fleetHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const given = env.FLEET_HOME ?? ''
  return given.trim() === '' ? join(homedir(), '.fleet') : resolve(given)
}

/** Where the gateway listens: `$FLEET_SOCKET`, or `fleet.sock` in its home. */
export function fleetSocket(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const given = env.FLEET_SOCKET ?? ''
  return given.trim() === '' ? join(fleetHome(env), 'fleet.sock') : resolve(given)
}

/** Where a box is in its life: stopped; started, its helper running; stopping; or gone, its container removed by other means. */
export type BoxState = 'stopped' | 'started' | 'stopping' | 'gone'

/** What a box is made with. */
export interface BoxSpec {
  /** The image, as `fleet image build` builds it; the gateway's default without it. */
  image?: string
  /** Its creator's, which the gateway keeps and lists, and tells each fleet server a connection of the box's goes to. */
  labels?: Record<string, string>
  /** The environment of every process in the box. */
  env?: Record<string, string>
  /** The services the box has, by name; without it, every service registered. */
  services?: string[]
  /** How long the box runs while nothing occupies it before it is stopped; the gateway's default without it. */
  idleStopMs?: number
}

/** A box, as the gateway has it. */
export interface BoxInfo {
  /** Its id, which its container is named by. */
  id: string
  image: string
  labels: Record<string, string>
  env: Record<string, string>
  /** The services it has, by name; null for every one registered. */
  services: string[] | null
  idleStopMs?: number
  createdAt: string
  state: BoxState
}

/** Something that needs a box running: its kind and its own id, both its holder's to choose, such as `turn` and an agent's id. */
export interface Occupant {
  kind: string
  id: string
}

/** A service, as it registers: its server, on the host, and its package, which the gateway puts in the boxes. */
export interface ServiceSpec {
  /** Its name, which names its socket in a box: lowercase letters, digits and hyphens, a letter first. */
  name: string
  /** What it is, which a harness may show its model. */
  description: string
  /**
   * A node package installed on this host, absolute, which the gateway copies
   * into each box that has the service, with the packages it depends on as
   * installed, and whose `bin` commands it puts on the box's PATH.
   */
  package: string
  /** What it adds to the environment of every process in a box that has it. */
  env?: Record<string, string>
  /** Its socket on this host, absolute, which the gateway opens a connection to for each one a box opens to the service's socket. */
  endpoint: string
}

/** A service, as the gateway has it. */
export interface ServiceInfo {
  name: string
  description: string
  /** Its commands, each by its name, the path of its program in its package. */
  bins: Record<string, string>
  env: Record<string, string>
  /** The digest of its package, as the gateway copied it. */
  digest: string
}

/** What a service's endpoint reads first of each connection, a line of JSON: the box it comes from, as the gateway knows it, never as the box says. */
export interface Preamble {
  box: string
  labels: Record<string, string>
}

/** Each op's params and result, and the events it sends before its result. */
export interface Ops {
  'box.create': { params: BoxSpec; result: BoxInfo }
  'box.list': { params: { labels?: Record<string, string> }; result: BoxInfo[] }
  'box.get': { params: { box: string }; result: BoxInfo }
  /** Start the box, if it is not started, without occupying it. */
  'box.start': { params: { box: string }; result: null }
  /** Stop the box, whatever occupies it. */
  'box.stop': { params: { box: string }; result: null }
  /** Stop the box as soon as nothing occupies it, now if nothing does. */
  'box.stopWhenVacant': { params: { box: string }; result: null }
  /** Remove the box, running or not, and forget it. */
  'box.remove': { params: { box: string }; result: null }
  /**
   * Occupy the box, so that it is not stopped for being idle, until the
   * lease's release, or the client's connection's end; with `start`, the
   * default, once the box is started, starting it if it is not.
   */
  'box.lease': { params: { box: string; occupant: Occupant; start?: boolean }; result: { lease: string } }
  'box.release': { params: { lease: string }; result: null }
  /** The box's state, as an event now and on each change, until the request is cancelled, or the box removed. */
  'box.watch': { params: { box: string }; result: null; event: { state: BoxState | 'removed' } }
  /**
   * A request of the box's helper, which answers as the helper does, with its
   * events: with `hold`, the default, occupying the box while it runs,
   * starting it if it is not started; without, of a box that is started.
   */
  'box.request': { [M in Method]: { params: { box: string; method: M; params: Methods[M]['params']; hold?: boolean }; result: Methods[M]['result']; event: Methods[M] extends { event: infer E } ? E : never } }[Method]
  /** Copy a host file to a path in the box, or a host folder's contents into a folder there, whether the box runs or not. */
  'box.copyIn': { params: { box: string; from: string; to: string }; result: null }
  /** Copy a box folder's contents into a host folder, whether the box runs or not. */
  'box.copyOut': { params: { box: string; from: string; to: string }; result: null }
  /**
   * Run a program in the box, without a shell and outside the helper, for
   * bytes, occupying the box while it runs: `input`, a host file, its stdin;
   * its stdout written to `output`, a host file, or else given back; an exit
   * other than 0 fails, with what it wrote to stderr.
   */
  'box.pipe': { params: { box: string; argv: string[]; input?: string; output?: string }; result: { stdout: string } }
  /** Register a service, the client's while its connection lasts, and put it in every box that has it. */
  'service.register': { params: ServiceSpec; result: ServiceInfo }
  'service.unregister': { params: { name: string }; result: null }
  'service.list': { params: Record<string, never>; result: ServiceInfo[] }
}

export type Op = keyof Ops

/** What an op sends before its result, or never for an op without events. */
export type OpEvent<O extends Op> = Ops[O] extends { event: infer E } ? E : never

/** The code of a failure for a box whose container was removed by other means: its owner makes another. */
export const BOX_GONE = 'BOX_GONE'
/** The code of a failure for a box the gateway does not know. */
export const NO_BOX = 'NO_BOX'
/** The code of a failure for a request that needs a started box, of one that is not. */
export const NOT_STARTED = 'NOT_STARTED'

/** Client to gateway: the wire's version, first; then requests, each answered once, and the cancelling of one that is not. */
export type ClientMessage =
  | { type: 'hello'; protocol: number }
  | { type: 'request'; id: number; op: string; params: unknown }
  | { type: 'cancel'; id: number }

/** Gateway to client: its version, once; then each request's events and its answer, its result or its failure, with the failure's code, if it has one. */
export type GatewayMessage =
  | { type: 'hello'; protocol: number }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'event'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string; code?: string }
