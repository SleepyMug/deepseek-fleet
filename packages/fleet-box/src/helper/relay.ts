/**
 * The box's services, as its programs reach them: one socket, the layout's
 * `servicesSocket`, which anyone in the box may open, since the box is its
 * own, taking HTTP/2 and HTTP/1.1 alike (fleet-net). Each call to
 * `/services/<name>/...` is carried to the gateway as it came, saying the
 * box's token, by which the gateway knows the box it is from, deciding whether the box may call the
 * service, and passing it on; anything else is refused.
 * @module @sleepymug/fleet-box/helper/relay
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { FailureSchema, Reason } from '@sleepymug/fleet-protocol/gateway'
import type { BoxLayout } from '@sleepymug/fleet-protocol/layout'
import { bearer, routeOf } from '@sleepymug/fleet-protocol/wire'
import { forward, listen, refuse, type Listener, type Upstream } from '@sleepymug/fleet-net'

/** Listen on the services' socket, carrying each call to the gateway through `gateway`, from the box whose token is `token`. */
export async function relay(layout: BoxLayout, token: string, gateway: Upstream): Promise<Listener> {
  await mkdir(dirname(layout.servicesSocket), { recursive: true })
  return await listen(layout.servicesSocket, {
    mode: 0o666,
    request: (req, res) => {
      const route = routeOf(req.url ?? '')
      if (route?.kind !== 'service') {
        refuse(req, res, new ConnectError(`${req.url ?? ''} is no service's: a service's calls go to /services/<name>/`, Code.NotFound, undefined, [
          create(FailureSchema, { reason: Reason.NO_SERVICE }),
        ].map(value => ({ desc: FailureSchema, value }))))
        return
      }
      // fleet's own headers, and the box's token, are the helper's to say, so a program's are dropped.
      forward(req, res, gateway, { path: req.url ?? '', headers: { authorization: bearer(token) }, drop: name => name.startsWith('fleet-') || name === 'authorization' })
    },
  })
}
