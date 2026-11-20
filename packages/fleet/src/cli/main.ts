#!/usr/bin/env node
/**
 * `fleet` (docs/fleet/cli/index.md): `fleet serve` runs the gateway in its
 * home, on its sockets; the other commands are its clients: they list,
 * make, start, stop and remove boxes, run programs and shells in them, and
 * list the services; `fleet image build` builds the box image from
 * fleet-box as installed.
 * @module @sleepymug/fleet/cli/main
 */

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildImage } from '@sleepymug/fleet-box/image/build'
import { BoxState } from '@sleepymug/fleet-protocol/gateway'
import { fleetHome, fleetSocket } from '@sleepymug/fleet-protocol/home'
import { DEFAULT_IMAGE } from '@sleepymug/fleet-protocol/layout'
import { Fleet } from '@sleepymug/fleet-sdk'
import { DockerDriver } from '../boxes/docker.ts'
import type { BoxDriver } from '../boxes/driver.ts'
import { LocalDriver } from '../boxes/local.ts'
import { FleetGateway } from '../gateway.ts'
import { fleetPaths } from '../home.ts'
import { serve } from '../http/server.ts'
import { systemPlatform } from '../platform.ts'
import { messageOf } from '../util/error.ts'
import { shell } from './shell.ts'

const USAGE = `Usage: fleet <command>

Commands:
  serve [--image <image>] [--driver docker|local]
                                run the gateway, until interrupted; the boxes
                                it started run on
  box list [--json]             list the boxes: id, state, services, labels
  box create [--image <image>] [--label <key>=<value>]... [--service <name>]...
             [--env <name>=<value>]...
                                make a box, stopped, and print its id
  box start <box>               start a box, which runs until it is stopped
  box stop <box>                stop a box
  box rm <box>...               remove boxes, running or not
  box exec <box> [--cwd <dir>] -- <program> [<arg>...]
                                run a program in a box, started first if it is
                                not, and exit as it does
  box sh <box> [-- <program> [<arg>...]]
                                a terminal in a box, started first if it is
                                not, its shell by default
  service list [--json]         list the services: name, commands, what each is
  image build [<tag>]           build the box image, ${DEFAULT_IMAGE} by default, from
                                fleet-box as installed

The gateway's home is $FLEET_HOME, or ~/.fleet; its clients' socket
$FLEET_SOCKET, or fleet.sock in its home.
`

/** A mistake in the command line, answered with a pointer to the usage. */
class UsageError extends Error {}

const STATES: Record<BoxState, string> = {
  [BoxState.UNSPECIFIED]: '?',
  [BoxState.STOPPED]: 'stopped',
  [BoxState.STARTING]: 'starting',
  [BoxState.STARTED]: 'started',
  [BoxState.STOPPING]: 'stopping',
  [BoxState.GONE]: 'gone',
}

/** Run `use` with a client, closing it after. */
async function withClient<T>(use: (fleet: Fleet) => Promise<T>): Promise<T> {
  const fleet = await Fleet.connect()
  try {
    return await use(fleet)
  } finally {
    await fleet.close()
  }
}

/** `<key>=<value>` pairs, as `--label` and `--env` take them. */
function pairs(given: readonly string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of given ?? []) {
    const at = pair.indexOf('=')
    if (at <= 0) throw new UsageError(`${what} is <key>=<value>, not ${pair}`)
    out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return out
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async serve(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { image: { type: 'string' }, driver: { type: 'string' } } })
    if (positionals.length > 0) throw new UsageError('serve takes no arguments')
    const paths = fleetPaths(fleetHome(), fleetSocket())
    const platform = systemPlatform()
    let driver: BoxDriver
    if (values.driver === undefined || values.driver === 'docker') driver = new DockerDriver({ gatewayDir: paths.gatewayDir })
    else if (values.driver === 'local') driver = new LocalDriver({ dir: join(paths.home, 'local-boxes'), gatewaySocket: paths.gatewaySocket, log: platform.log })
    else throw new UsageError('--driver takes docker or local')
    const gateway = await FleetGateway.open({ paths, driver, platform, image: values.image ?? DEFAULT_IMAGE })
    const served = await serve(gateway, { clients: paths.socket, boxes: paths.gatewaySocket }, platform.log)
    platform.log(`serving on ${paths.socket}, and to its boxes on ${paths.gatewaySocket}`)
    if (values.driver === 'local') platform.log('its boxes are folders here, which nothing isolates')
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { resolve() })
    })
    await served.close()
    // Its boxes run on, and their helpers dial the next gateway, unless the driver's cannot outlive it.
    await driver.close?.()
  },

  async box(args) {
    const [verb, ...rest] = args
    switch (verb) {
      case 'list': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } })
        if (positionals.length > 0) throw new UsageError('box list takes no arguments')
        await withClient(async (fleet) => {
          const boxes = await fleet.list()
          if (values.json === true) {
            process.stdout.write(`${JSON.stringify(boxes.map(box => ({ ...box, $typeName: undefined, state: STATES[box.state], createdAt: undefined })), null, 2)}\n`)
            return
          }
          table([['BOX', 'STATE', 'SERVICES', 'LABELS'], ...boxes.map(box => [
            box.id, STATES[box.state], box.services.join(' ') || '-', Object.entries(box.labels).map(([key, value]) => `${key}=${value}`).join(' '),
          ])])
        })
        return
      }
      case 'create': {
        const { values, positionals } = parseArgs({
          args: rest, allowPositionals: true,
          options: { image: { type: 'string' }, label: { type: 'string', multiple: true }, service: { type: 'string', multiple: true }, env: { type: 'string', multiple: true } },
        })
        if (positionals.length > 0) throw new UsageError('box create takes no arguments')
        await withClient(async (fleet) => {
          const box = await fleet.create({
            image: values.image ?? '',
            labels: pairs(values.label, 'a label'),
            env: pairs(values.env, 'an environment variable'),
            services: values.service ?? [],
          })
          process.stdout.write(`${box.id}\n`)
        })
        return
      }
      case 'start':
      case 'stop': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true })
        if (positionals.length !== 1) throw new UsageError(`box ${verb} takes one box`)
        await withClient(async (fleet) => {
          const box = fleet.box(positionals[0] as string)
          await (verb === 'start' ? box.start() : box.stop())
        })
        return
      }
      case 'rm': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true })
        if (positionals.length === 0) throw new UsageError('box rm takes the boxes to remove')
        await withClient(async (fleet) => {
          for (const id of positionals) {
            try {
              await fleet.box(id).remove()
            } catch (error) {
              process.stderr.write(`fleet: ${messageOf(error)}\n`)
              process.exitCode = 1
            }
          }
        })
        return
      }
      case 'exec': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { cwd: { type: 'string' } } })
        const [id, ...argv] = positionals
        if (id === undefined || argv.length === 0) throw new UsageError('box exec takes a box, then --, then a program and its arguments')
        await withClient(async (fleet) => {
          const box = fleet.box(id)
          await box.start()
          const { exit, stdout, stderr } = await box.exec(argv, values.cwd === undefined ? {} : { cwd: values.cwd })
          process.stdout.write(stdout)
          process.stderr.write(stderr)
          process.exitCode = exit?.code ?? 128
        })
        return
      }
      case 'sh': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true })
        const [id, ...argv] = positionals
        if (id === undefined) throw new UsageError('box sh takes a box')
        await withClient(async (fleet) => {
          const box = fleet.box(id)
          await box.start()
          process.exitCode = await shell(box, argv.length === 0 ? ['/bin/sh', '-l'] : argv)
        })
        return
      }
      default:
        throw new UsageError(verb === undefined ? 'box takes list, create, start, stop, rm, exec or sh' : `no command box ${verb}`)
    }
  },

  async service(args) {
    const [verb, ...rest] = args
    if (verb !== 'list') throw new UsageError(verb === undefined ? 'service takes list' : `no command service ${verb}`)
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } })
    if (positionals.length > 0) throw new UsageError('service list takes no arguments')
    await withClient(async (fleet) => {
      const services = await fleet.serviceList()
      if (values.json === true) {
        process.stdout.write(`${JSON.stringify(services.map(service => ({ ...service, $typeName: undefined })), null, 2)}\n`)
        return
      }
      table([['SERVICE', 'COMMANDS', 'WHAT IT IS'], ...services.map(service => [service.name, service.commands.map(command => command.name).join(' ') || '-', service.description])])
    })
  },

  async image(args) {
    const [verb, ...rest] = args
    if (verb !== 'build') throw new UsageError(verb === undefined ? 'image takes build' : `no command image ${verb}`)
    const { positionals } = parseArgs({ args: rest, allowPositionals: true })
    if (positionals.length > 1) throw new UsageError('image build takes one tag at most')
    await buildImage(positionals[0] === undefined ? {} : { tag: positionals[0] })
  },
}

/** Rows as columns, the last as it is. */
function table(rows: string[][]): void {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map(row => (row[column] ?? '').length)))
  for (const row of rows) {
    process.stdout.write(`${row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)).join('  ')}\n`)
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (command === undefined || !Object.hasOwn(commands, command)) {
    throw new UsageError(command === undefined ? 'no command given' : `no command ${command}`)
  }
  await (commands[command] as (args: string[]) => Promise<void>)(args)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  const usage = error instanceof UsageError || (error as { code?: unknown }).code?.toString().startsWith('ERR_PARSE_ARGS') === true
  process.stderr.write(`fleet: ${messageOf(error)}${usage ? '\nRun `fleet --help` for the commands.' : ''}\n`)
  process.exitCode = usage ? 2 : 1
}
