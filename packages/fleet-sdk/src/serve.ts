/**
 * A service served to the gateway, from wherever its server runs: its spec
 * staged, its package, if it has one, staged as installed here and
 * uploaded if the gateway lacks it, then a tunnel opened to the gateway,
 * naming the spec, over which the server serves the service's calls as any
 * Connect server does, each from a box or a client, as the gateway says
 * (./caller.ts). The service is registered for as long as the tunnel
 * lasts; one lost is opened again, the spec staged again if the gateway
 * no longer knows it.
 * @module @sleepymug/fleet-sdk/serve
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create, type DescService } from '@bufbuild/protobuf'
import type { FileDescriptorSet } from '@bufbuild/protobuf/wkt'
import type { Client, ConnectRouter } from '@connectrpc/connect'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { Reason, type Services, UploadPackageRequestSchema } from '@sleepymug/fleet-protocol/gateway'
import { HEADERS, TUNNEL_PATH, TUNNEL_PROTOCOL } from '@sleepymug/fleet-protocol/wire'
import { keepTunnel, openTunnel, TunnelRefused } from '@sleepymug/fleet-net'
import { digestOf, packTree, stagePackage } from '@sleepymug/fleet-pack'

/** A service, as its server serves it. */
export interface ServiceDefinition {
  /** Its name: lowercase letters, digits and hyphens, a letter first. */
  name: string
  /** What it is, and how a box's programs use it, in a sentence. */
  description: string
  /** Its schema, with its comments, and every file it imports, as `buf build` makes it. */
  schema: FileDescriptorSet
  /** The protobuf services it serves, as their generated code has them, or by their full names. */
  services: readonly (DescService | string)[]
  /** What serves its calls, as a Connect router takes them. */
  routes: (router: ConnectRouter) => void
  /** A node package installed on this machine, whose folder each box that has the service gets, its commands on the PATH. */
  package?: string
  /** What it adds to the environment of every process in a box that has it. */
  env?: Record<string, string>
  /** What each of its package's commands does, in a sentence, by the command's name, for the box's README. */
  commands?: Record<string, string>
}

/** A service registered, for as long as its tunnel lasts. */
export interface Registration {
  /** The digest of its spec. */
  readonly spec: string
  /** Close its tunnel, which unregisters it. */
  close(): void
}

export interface ServeDeps {
  socket: string
  services: Client<typeof Services>
  log: (message: string) => void
}

/** Serve a service to the gateway, and settle once it is registered. */
export async function serveService(definition: ServiceDefinition, { socket, services, log }: ServeDeps): Promise<Registration> {
  const staged = definition.package === undefined ? undefined : await stage(definition.package)
  const request = {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    services: definition.services.map(service => (typeof service === 'string' ? service : service.typeName)),
    package: staged?.digest ?? '',
    env: definition.env ?? {},
    commands: definition.commands ?? {},
  }
  const register = async (): Promise<string> => {
    const { spec, upload } = await services.stage(request)
    if (upload && staged !== undefined) {
      async function* parts() {
        yield create(UploadPackageRequestSchema, { part: { case: 'digest', value: staged?.digest ?? '' } })
        for await (const chunk of packTree(staged?.dir ?? '')) yield create(UploadPackageRequestSchema, { part: { case: 'chunk', value: chunk } })
      }
      await services.upload(parts())
    }
    return spec
  }
  let spec = await register()
  const server = createServer(connectNodeAdapter({ routes: definition.routes }))
  server.on('sessionError', () => {})
  const tunnel = keepTunnel({
    log: message => log(`${definition.name}: ${message}`),
    open: () => openTunnel({
      socket,
      path: TUNNEL_PATH,
      protocol: TUNNEL_PROTOCOL,
      headers: { [HEADERS.tunnel]: 'service', [HEADERS.service]: definition.name, [HEADERS.spec]: spec },
      server,
    }),
    // Another server serving the name is not waited out.
    fatal: error => error instanceof TunnelRefused && error.headers[HEADERS.reason] === Reason[Reason.NAME_TAKEN],
    // A gateway that lost the spec or the package, as one started afresh, is given them again.
    recover: async (error) => {
      const reason = error instanceof TunnelRefused ? error.headers[HEADERS.reason] : undefined
      if (reason === Reason[Reason.UNKNOWN_SPEC] || reason === Reason[Reason.NO_PACKAGE] || !(error instanceof TunnelRefused)) spec = await register()
    },
  })
  try {
    await tunnel.opened
  } catch (error) {
    tunnel.close()
    server.close()
    await staged?.cleanup()
    throw error
  }
  return {
    get spec() { return spec },
    close: () => {
      tunnel.close()
      server.close()
      void staged?.cleanup()
    },
  }
}

/** A package as installed here, staged with what it depends on, and its digest. */
async function stage(root: string): Promise<{ dir: string; digest: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-package-'))
  try {
    await stagePackage(root, join(dir, 'package'))
    const digest = await digestOf(join(dir, 'package'))
    return { dir: join(dir, 'package'), digest, cleanup: () => rm(dir, { recursive: true, force: true }) }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
