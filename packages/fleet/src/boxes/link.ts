/**
 * A box's helper, as the gateway reaches it: the tunnel the helper opened,
 * naming its box, through which the box's API's calls go, and the
 * gateway's own of `Provision`.
 * @module @sleepymug/fleet/boxes/link
 */

import { createClient, type Client } from '@connectrpc/connect'
import { Provision } from '@sleepymug/fleet-protocol/box'
import { connectTransport, type AcceptedTunnel, type Upstream } from '@sleepymug/fleet-net'

export interface HelperLink {
  /** Where the box's calls go. */
  readonly upstream: Upstream
  /** The gateway's own calls of the helper. */
  readonly provision: Client<typeof Provision>
  /** Settles once the tunnel is closed. */
  readonly closed: Promise<void>
  close(): void
}

export function helperLink(tunnel: AcceptedTunnel): HelperLink {
  return {
    upstream: tunnel.upstream,
    provision: createClient(Provision, connectTransport(tunnel.upstream)),
    closed: tunnel.closed,
    close: () => { tunnel.close() },
  }
}
