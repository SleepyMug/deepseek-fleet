/**
 * The extensions provided to the fleet host (docs/fleet-core/ext/index.md):
 * each implements one contract (tau's docs/spec/contracts.md), at a version,
 * with a client, which runs in the box as the implementation of each API
 * that is a copy of it, and a server, its methods here, which the client
 * calls. An extension is a dsh plugin of its own, which provides itself as
 * long as it is loaded. This holds only what is
 * provided; the runs of taus link it, and relay the calls (../tau/).
 * @module @sleepymug/fleet-core/ext/exts
 */

import { isAbsolute } from 'node:path'
import { parseVersion } from '@sleepymug/tau'

export { STREAMED, streamed, type Streamed } from '../box/helper.ts'

/** What a server's method is told of a call, besides its arguments. */
export interface CallContext {
  /** The session whose box made the call, as the fleet host knows it, never as the call says. */
  sessionId: string
  /** Aborts when the caller in the box has gone, or the box's helper has. */
  signal: AbortSignal
  /** The bytes the call sent after it, such as an archive, if it sent any, read once. */
  body?: AsyncIterable<Uint8Array>
}

/**
 * A method of an extension's server. Its arguments come from the box, where
 * the model can send anything, so it checks them; it answers with JSON, or
 * nothing, for null, or with JSON and bytes after it, a `Streamed`, which it
 * makes as `{ [Symbol.for('fleet.streamed')]: true, value, body }`, or with
 * `streamed(value, body)`; and what it throws is the client's failure.
 */
export type ExtMethod = (args: unknown[], call: CallContext) => unknown

export interface Ext {
  /** The contract it implements, by its package's name. */
  contract: string
  /**
   * The version of the contract it implements, as its package says, such as
   * the version it is built and type-checked against: it serves a tau whose
   * copy of the contract that version serves.
   */
  version: string
  /**
   * Its client's folder, absolute: index.js, the implementation. It is
   * copied into each box whose tau holds the contract, so it is
   * self-contained: it imports only its own files, Node's modules, and
   * fleet's client runtime, `@sleepymug/fleet-box-runtime/ext/client`.
   */
  client: string
  /** Its server's methods, by name; none for a client that works in the box alone. */
  methods: Readonly<Record<string, ExtMethod>>
}

/** A contract's name, an npm package's, scoped or not (tau's docs/spec/contracts.md). */
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

export class FleetExts {
  private readonly provided = new Map<string, Ext>()

  /**
   * Provide an extension, for as long as the plugin that provides it is
   * loaded: `ctx.effect(() => ctx.fleetExts.provide(…))`.
   * @returns what withdraws it.
   * @throws for a contract another extension implements.
   */
  provide(ext: Ext): () => void {
    if (typeof ext?.contract !== 'string' || !NAME.test(ext.contract)) throw new TypeError('fleet: an extension implements a contract, by its package\'s name')
    if (typeof ext.version !== 'string' || parseVersion(ext.version) === undefined) throw new TypeError(`fleet: the extension of ${ext.contract} implements it at a version, a SemVer one`)
    if (typeof ext.client !== 'string' || !isAbsolute(ext.client)) throw new TypeError(`fleet: the extension of ${ext.contract} names its client's folder, an absolute path`)
    if (this.provided.has(ext.contract)) throw new Error(`fleet: an extension of ${ext.contract} is provided already`)
    const own: Ext = { contract: ext.contract, version: ext.version, client: ext.client, methods: { ...ext.methods } }
    this.provided.set(ext.contract, own)
    return () => {
      if (this.provided.get(own.contract) === own) this.provided.delete(own.contract)
    }
  }

  /** The extension that implements a contract, if one is provided. */
  get(contract: string): Ext | undefined {
    return this.provided.get(contract)
  }
}
