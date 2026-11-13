/**
 * The helper, fleet's process in a box, put together from what it is
 * given: it dials the gateway, opens a tunnel naming the box, and serves the
 * box's API over it, `Box`, its processes, terminals and files, and
 * `Provision`, which the gateway asks as the box starts; it opens the tunnel
 * again whenever it is lost, as when the gateway restarts. And it serves
 * the box's services to its programs, on the services' socket, carrying
 * their calls to the gateway on a connection of its own (./relay.ts). It
 * ends what it started as it closes.
 * @module @sleepymug/fleet-box/helper
 */

import { createServer } from 'node:http2'
import type { ConnectRouter } from '@connectrpc/connect'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { Box, Provision as ProvisionService } from '@sleepymug/fleet-protocol/box'
import { BOX_LAYOUT, type BoxLayout } from '@sleepymug/fleet-protocol/layout'
import { HEADERS, HELPER_PROTOCOL, TUNNEL_PATH, TUNNEL_PROTOCOL } from '@sleepymug/fleet-protocol/wire'
import { dial, keepTunnel, openTunnel } from '@sleepymug/fleet-net'
import { boxEnvironment, type Environment } from './box/env.ts'
import * as files from './box/files.ts'
import { Processes } from './box/processes.ts'
import { Terminals } from './box/terminal.ts'
import { Provision } from './provision.ts'
import { relay } from './relay.ts'

export interface HelperOptions {
  /** The gateway's socket, which the helper dials. */
  gateway: string
  /** The box's id, which the tunnel names. */
  box: string
  /** Where things are in the box: the box's own layout unless a test roots it elsewhere. */
  layout?: BoxLayout
  /** The helper's environment, the box's, with its services': every program's, less the helper's own. */
  env?: Environment
  /** Told what goes wrong outside a call. */
  log?: (message: string) => void
}

export interface Helper {
  /** End what the helper started, close its tunnel and its socket. */
  close(): Promise<void>
}

/** Start a helper, and settle once its tunnel to the gateway first opens. */
export async function startHelper({ gateway, box, layout = BOX_LAYOUT, env = process.env, log = () => {} }: HelperOptions): Promise<Helper> {
  const boxEnv = boxEnvironment(env, layout)
  const processes = new Processes(boxEnv, layout)
  const terminals = new Terminals(boxEnv, layout)
  const provision = new Provision(layout)
  const routes = (router: ConnectRouter): void => {
    router.service(Box, {
      exec: req => processes.exec(req),
      spawn: (requests, ctx) => processes.spawn(requests, ctx),
      which: req => processes.which(req),
      terminal: (requests, ctx) => terminals.run(requests, ctx),
      stat: req => files.statOf(req),
      resolve: req => files.resolvePath(req),
      watch: (req, ctx) => files.watch(req, ctx.signal),
      listDir: req => files.listDir(req),
      readFile: req => files.readFile(req),
      writeFile: requests => files.writeFile(requests),
      makeDir: req => files.makeDir(req),
      remove: req => files.remove(req),
      rename: req => files.move(req),
      put: requests => files.put(requests),
      get: req => files.get(req),
    })
    router.service(ProvisionService, {
      installed: () => provision.installed(),
      install: requests => provision.install(requests),
    })
  }
  const server = createServer(connectNodeAdapter({ routes }))
  // A connection of the tunnel that breaks its protocol is the gateway's to open again.
  server.on('sessionError', () => {})
  const upstream = dial(gateway)
  const services = await relay(layout, box, upstream)
  const tunnel = keepTunnel({
    log,
    open: () => openTunnel({
      socket: gateway,
      path: TUNNEL_PATH,
      protocol: TUNNEL_PROTOCOL,
      headers: { [HEADERS.tunnel]: 'box', [HEADERS.box]: box, [HEADERS.helperProtocol]: String(HELPER_PROTOCOL) },
      server,
    }),
  })
  await tunnel.opened
  let closing: Promise<void> | undefined
  return {
    close: () => {
      closing ??= (async () => {
        await Promise.allSettled([processes.close(), terminals.close()])
        tunnel.close()
        await services.close()
        upstream.close()
        server.close()
      })()
      return closing
    },
  }
}
