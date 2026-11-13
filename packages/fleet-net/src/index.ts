/**
 * `@sleepymug/fleet-net`: how fleet's ends reach one another over HTTP/2,
 * knowing nothing of boxes or services.
 * - {@link listen}: a Unix socket that takes HTTP/1.1 and HTTP/2 alike.
 * - {@link dial} and {@link sessionUpstream}: where calls go.
 * - {@link openTunnel} and {@link acceptTunnel}: a connection its dialer serves over.
 * - {@link forward}: a call carried through to an upstream.
 * - {@link refuse}: a call refused as its protocol has it.
 * - {@link connectTransport}: Connect's calls through an upstream.
 * @module @sleepymug/fleet-net
 */

import { createConnectTransport } from '@connectrpc/connect-node'
import type { Interceptor, Transport } from '@connectrpc/connect'
import { AUTHORITY, type Upstream } from './upstream.ts'

export { listen, type Handler, type Listener, type ListenOptions, type Request, type Response, type UpgradeHandler } from './listen.ts'
export { AUTHORITY, dial, sessionUpstream, type Dialed, type Upstream } from './upstream.ts'
export { acceptTunnel, keepTunnel, openTunnel, refuseTunnel, TunnelRefused, type AcceptedTunnel, type KeepTunnel, type KeptTunnel, type OpenTunnel, type Tunnel } from './tunnel.ts'
export { forward, type Carry } from './proxy.ts'
export { refuse } from './refuse.ts'

/** Connect's calls, in its binary format, through `upstream`, each at `base` and its method's path. */
export function connectTransport(upstream: Upstream, base = '', interceptors: Interceptor[] = []): Transport {
  return createConnectTransport({ httpVersion: '2', baseUrl: `http://${AUTHORITY}${base}`, sessionManager: upstream, useBinaryFormat: true, interceptors })
}
