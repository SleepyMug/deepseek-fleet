/**
 * What the gateway's tests share: a gateway of their own, on sockets in a
 * folder of their own, its boxes local ones (./boxes/local.ts), each a
 * folder with the helper as built running for it; and the echo service,
 * its schema built with buf, as a server would have it.
 * @module @sleepymug/fleet/test.util
 */

import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createFileRegistry, type DescService } from '@bufbuild/protobuf'
import { type FileDescriptorSet, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt'
import { fromBinary } from '@bufbuild/protobuf'
import type { ConnectRouter } from '@connectrpc/connect'
import { callerOf, Fleet } from '@sleepymug/fleet-sdk'
import { LocalDriver } from './boxes/local.ts'
import { FleetGateway } from './gateway.ts'
import { fleetPaths, type FleetPaths } from './home.ts'
import { serve, type Serving } from './http/server.ts'
import { systemPlatform } from './platform.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

export interface Serve {
  dir: string
  paths: FleetPaths
  driver: LocalDriver
  gateway: FleetGateway
  serving: Serving
  client: Fleet
  logs: string[]
  /** Stop this gateway, its boxes left running, and serve another in the same home, with the same boxes. */
  restart(): Promise<void>
}

/** A gateway of the test's, closed once the test ends. */
export async function serving(t: { after: (fn: () => Promise<void>) => void }, options: { idleStopMs?: number } = {}): Promise<Serve> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-gw-'))
  const paths = fleetPaths(join(dir, 'home'))
  const logs: string[] = []
  const log = (message: string): void => { logs.push(message) }
  const driver = new LocalDriver({ dir: join(dir, 'boxes'), gatewaySocket: paths.gatewaySocket, log })
  const open = async () => {
    const gateway = await FleetGateway.open({ paths, driver, platform: systemPlatform(log), image: 'local', idleStopMs: options.idleStopMs ?? 60_000 })
    const served = await serve(gateway, { clients: paths.socket, boxes: paths.gatewaySocket }, log)
    return { gateway, served }
  }
  const first = await open()
  const state: Serve = {
    dir, paths, driver, logs,
    gateway: first.gateway,
    serving: first.served,
    client: await Fleet.connect({ socket: paths.socket, log }),
    restart: async () => {
      await state.serving.close()
      const next = await open()
      state.gateway = next.gateway
      state.serving = next.served
    },
  }
  t.after(async () => {
    await state.client.close()
    await state.serving.close()
    await state.gateway.close()
    for (const box of state.gateway.listBoxes()) await driver.remove(box.id).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  return state
}

/** The echo service's schema, as `buf build` makes it, with its comments. */
export async function echoSchema(dir: string): Promise<{ schema: FileDescriptorSet; Echo: DescService }> {
  await cp(join(HERE, '..', 'src', 'test-proto'), join(dir, 'echo-proto'), { recursive: true })
  await writeFile(join(dir, 'echo-proto', 'buf.yaml'), 'version: v2\n')
  await promisify(execFile)(join(ROOT, 'node_modules', '.bin', 'buf'), ['build', '--output', join(dir, 'echo.binpb')], { cwd: join(dir, 'echo-proto') })
  const schema = fromBinary(FileDescriptorSetSchema, await readFile(join(dir, 'echo.binpb')))
  const Echo = createFileRegistry(schema).getService('echo.v1.Echo') as DescService
  return { schema, Echo }
}

/** The echo service's routes: each answer says who called, as the gateway says it. */
export function echoRoutes(Echo: DescService): (router: ConnectRouter) => void {
  const from = (ctx: Parameters<typeof callerOf>[0]): { from: string; labels: Record<string, string> } => {
    const { caller } = callerOf(ctx)
    return caller.case === 'box' ? { from: caller.value.id, labels: caller.value.labels } : { from: 'client', labels: {} }
  }
  return router => router.service(Echo, {
    say: (req: { text: string }, ctx: Parameters<typeof callerOf>[0]) => ({ text: req.text, ...from(ctx) }),
    async *repeat(req: { text: string; times: number }, ctx: Parameters<typeof callerOf>[0]) {
      for (let i = 0; i < req.times; i++) yield { text: `${req.text} ${i + 1}`, ...from(ctx) }
    },
  } as never)
}

/** Settles once `check` holds, checking every 20 ms, or fails after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 5000, what = 'the condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
