/**
 * The gateway's HTTP/2 surface, as its ends meet on it: the paths a call
 * goes to, the headers that say what the gateway alone may say, and the
 * tunnels, the connections a service's server or a box's helper dials and
 * then serves over, the gateway calling it.
 *
 * - `/fleet.v1.<Service>/<Method>`: the gateway's own API.
 * - `/boxes/<id>/fleet.box.v1.Box/<Method>`: a box's API, which the gateway
 *   carries to the box's helper.
 * - `/services/<name>/<package>.<Service>/<Method>`: a service, which the
 *   gateway carries to its server, saying who calls in {@link HEADERS}.caller.
 * - {@link TUNNEL_PATH}: a tunnel, a WebSocket speaking {@link TUNNEL_PROTOCOL}.
 * @module @sleepymug/fleet-protocol/wire
 */

import { create, fromBinary, type MessageInitShape, toBinary } from '@bufbuild/protobuf'
import { type Caller, CallerSchema } from './fleet.ts'

/** The version of the helper's side of its tunnel, which the gateway checks. */
export const HELPER_PROTOCOL = 1

/** Where a tunnel is opened: a WebSocket, by an HTTP/1.1 upgrade or an HTTP/2 extended CONNECT. */
export const TUNNEL_PATH = '/fleet/tunnel'

/** The WebSocket subprotocol a tunnel speaks: HTTP/2, the dialer serving it. */
export const TUNNEL_PROTOCOL = 'fleet-tunnel'

/** What a tunnel serves: a service's calls, or a box's. */
export type TunnelKind = 'service' | 'box'

/** The headers of fleet's own. */
export const HEADERS = {
  /** A tunnel's kind, {@link TunnelKind}. */
  tunnel: 'fleet-tunnel',
  /** A service's tunnel: the service's name. */
  service: 'fleet-service',
  /** A service's tunnel: the digest of the spec it serves, as staged. */
  spec: 'fleet-spec',
  /** A box's tunnel, and the calls its helper carries from its programs: the box's id. */
  box: 'fleet-box',
  /** A box's tunnel: {@link HELPER_PROTOCOL}. */
  helperProtocol: 'fleet-helper-protocol',
  /** A call of a box's API: `false` not to occupy the box while it runs, which then needs it started. */
  hold: 'fleet-hold',
  /** A call the gateway carries to a service: who calls, a {@link Caller}, in binary, base64. */
  caller: 'fleet-caller-bin',
  /** A refused tunnel: why, a `Reason`'s name. */
  reason: 'fleet-reason',
} as const

/** A service's name: lowercase letters, digits and hyphens, a letter first. */
export const SERVICE_NAME = /^[a-z][a-z0-9-]*$/u

/** A box's id: `box-` and 16 hex digits. */
export const BOX_ID = /^box-[0-9a-f]{16}$/u

/** Where a service's calls go. */
export function servicePath(name: string): string {
  return `/services/${name}`
}

/** Where a box's calls go. */
export function boxPath(id: string): string {
  return `/boxes/${id}`
}

/** Where a call goes, by its path: a service's, a box's, or the gateway's own. */
export type Route =
  | { kind: 'service'; name: string; path: string }
  | { kind: 'box'; box: string; path: string }
  | { kind: 'gateway'; path: string }

/** Where a call to `path` goes, the rest of the path what its server is asked; a service or box not named rightly goes nowhere. */
export function routeOf(path: string): Route | undefined {
  const match = /^\/(services|boxes)\/([^/]*)(\/.*)$/u.exec(path)
  if (match === null) return path.startsWith('/fleet.v1.') ? { kind: 'gateway', path } : undefined
  const [, kind, name = '', rest = ''] = match
  if (kind === 'services') return SERVICE_NAME.test(name) ? { kind: 'service', name, path: rest } : undefined
  return BOX_ID.test(name) ? { kind: 'box', box: name, path: rest } : undefined
}

/** A caller as the header carries it. */
export function encodeCaller(caller: MessageInitShape<typeof CallerSchema>): string {
  return Buffer.from(toBinary(CallerSchema, create(CallerSchema, caller))).toString('base64')
}

/** The caller a header says. */
export function decodeCaller(value: string): Caller {
  return fromBinary(CallerSchema, Buffer.from(value, 'base64'))
}
