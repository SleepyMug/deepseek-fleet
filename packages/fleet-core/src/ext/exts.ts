/**
 * The extensions provided to the fleet host (docs/fleet-core/ext/index.md):
 * each implements one API a tau may declare, with a client, which runs in
 * the box as the API's implementation, and a server, its methods here,
 * which the client calls. An extension is a dsh plugin of its own, which
 * provides itself as long as it is loaded. This holds only what is
 * provided; the runs of taus link it, and relay the calls (../tau/).
 * @module fleet-core/ext/exts
 */

import { isAbsolute } from 'node:path'

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
  /** The API it implements, by the name a tau declares it under, in api/<name>/. */
  api: string
  /**
   * Its client's folder, absolute: index.js, the implementation, with its
   * declarations beside it, which the API is checked against. It is copied
   * into each box whose tau declares the API, so it is self-contained: it
   * imports only its own files, Node's modules, and fleet's client runtime,
   * `fleet-box-runtime/ext/client`.
   */
  client: string
  /** Its server's methods, by name; none for a client that works in the box alone. */
  methods: Readonly<Record<string, ExtMethod>>
}

/** What an API's name may be (tau's docs/spec/apis.md). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export class FleetExts {
  private readonly provided = new Map<string, Ext>()

  /**
   * Provide an extension, for as long as the plugin that provides it is
   * loaded: `ctx.effect(() => ctx.fleetExts.provide(…))`.
   * @returns what withdraws it.
   * @throws for an API another extension implements.
   */
  provide(ext: Ext): () => void {
    if (typeof ext?.api !== 'string' || !NAME.test(ext.api)) throw new TypeError(`fleet: an extension implements an API, by a name that matches ${NAME.source}`)
    if (typeof ext.client !== 'string' || !isAbsolute(ext.client)) throw new TypeError(`fleet: the extension of ${ext.api} names its client's folder, an absolute path`)
    if (this.provided.has(ext.api)) throw new Error(`fleet: an extension of ${ext.api} is provided already`)
    const own: Ext = { api: ext.api, client: ext.client, methods: { ...ext.methods } }
    this.provided.set(ext.api, own)
    return () => {
      if (this.provided.get(own.api) === own) this.provided.delete(own.api)
    }
  }

  /** The extension that implements an API, if one is provided. */
  get(api: string): Ext | undefined {
    return this.provided.get(api)
  }
}
