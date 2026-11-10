#!/usr/bin/env node
/**
 * `fleet` (docs/fleet/cli/index.md): `fleet serve` runs the fleet host on
 * its socket, in its home; the other commands are its clients: they list,
 * make and remove boxes, send methods to a box's helper from a REPL
 * (./repl.ts), and list the services; `fleet image build` builds the box
 * image from fleet-box as installed.
 * @module @sleepymug/fleet/cli/main
 */

import { parseArgs } from 'node:util'
import { FleetClient } from '@sleepymug/fleet-client'
import { buildImage } from '@sleepymug/fleet-box/image/build'
import { DEFAULT_IMAGE } from '@sleepymug/fleet-protocol/layout'
import { fleetHome, fleetSocket } from '@sleepymug/fleet-protocol/fleet'
import { FleetHost } from '../host.ts'
import { fleetPaths } from '../paths.ts'
import { systemPlatform } from '../platform.ts'
import { Registry } from '../registry.ts'
import { listen } from '../server.ts'
import { messageOf } from '../util/error.ts'
import { repl } from './repl.ts'

const USAGE = `Usage: fleet <command>

Commands:
  serve [--image <image>] [--idle-stop <ms>]
                                run the fleet host, until interrupted
  box list [--json]             list the boxes: id, state, labels
  box create [--image <image>] [--label <key>=<value>]... [--service <name>]...
                                make a box, stopped, and print its id
  box rm <box>...               remove boxes, running or not
  box repl <box>                send methods to a box's helper from a REPL, the box
                                occupied, and started, until the REPL is left
  service list [--json]         list the services: name, commands, what each is
  image build [<tag>]           build the box image, ${DEFAULT_IMAGE} by default, from
                                fleet-box as installed

The host's home is $FLEET_HOME, or ~/.fleet; its socket $FLEET_SOCKET, or
fleet.sock in its home.
`

/** A mistake in the command line, answered with a pointer to the usage. */
class UsageError extends Error {}

async function client(): Promise<FleetClient> {
  return await FleetClient.connect()
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async serve(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { image: { type: 'string' }, 'idle-stop': { type: 'string' } } })
    if (positionals.length > 0) throw new UsageError('serve takes no arguments')
    const idleStopMs = values['idle-stop'] === undefined ? undefined : Number(values['idle-stop'])
    if (idleStopMs !== undefined && (!Number.isFinite(idleStopMs) || idleStopMs < 0)) throw new UsageError('--idle-stop takes milliseconds, 0 or more')
    const paths = fleetPaths(fleetHome(), fleetSocket())
    const platform = systemPlatform()
    const host = new FleetHost({
      registry: new Registry(paths.boxes), cache: paths.services, platform,
      ...values.image === undefined ? {} : { image: values.image },
      ...idleStopMs === undefined ? {} : { idleStopMs },
    })
    await host.load()
    const close = await listen(paths.socket, host)
    platform.log(`serving on ${paths.socket}`)
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { resolve() })
    })
    platform.log('stopping the boxes started here')
    await close()
    await host.close()
  },

  async box(args) {
    const [verb, ...rest] = args
    if (verb === 'list') {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } })
      if (positionals.length > 0) throw new UsageError('box list takes no arguments')
      const fleet = await client()
      try {
        const boxes = await fleet.list()
        if (values.json === true) {
          process.stdout.write(`${JSON.stringify(boxes, null, 2)}\n`)
          return
        }
        table([['BOX', 'STATE', 'LABELS'], ...boxes.map(box => [box.id, box.state, Object.entries(box.labels).map(([key, value]) => `${key}=${value}`).join(' ')])])
      } finally {
        await fleet.close()
      }
      return
    }
    if (verb === 'create') {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { image: { type: 'string' }, label: { type: 'string', multiple: true }, service: { type: 'string', multiple: true } },
      })
      if (positionals.length > 0) throw new UsageError('box create takes no arguments')
      const labels: Record<string, string> = {}
      for (const label of values.label ?? []) {
        const at = label.indexOf('=')
        if (at <= 0) throw new UsageError(`a label is <key>=<value>, not ${label}`)
        labels[label.slice(0, at)] = label.slice(at + 1)
      }
      const fleet = await client()
      try {
        const box = await fleet.create({ labels, ...values.image === undefined ? {} : { image: values.image }, ...values.service === undefined ? {} : { services: values.service } })
        process.stdout.write(`${box.id}\n`)
      } finally {
        await fleet.close()
      }
      return
    }
    if (verb === 'rm') {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true })
      if (positionals.length === 0) throw new UsageError('box rm takes the boxes to remove')
      const fleet = await client()
      try {
        for (const id of positionals) {
          try {
            await fleet.box(id).remove()
          } catch (error) {
            process.stderr.write(`fleet: ${messageOf(error)}\n`)
            process.exitCode = 1
          }
        }
      } finally {
        await fleet.close()
      }
      return
    }
    if (verb === 'repl') {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true })
      if (positionals.length !== 1) throw new UsageError('box repl takes one box')
      const [id] = positionals as [string]
      const fleet = await client()
      const box = fleet.box(id)
      const release = await box.lease({ kind: 'repl', id: String(process.pid) })
      const interrupt = new AbortController()
      const onInterrupt = (): void => { interrupt.abort() }
      process.on('SIGINT', onInterrupt)
      try {
        process.stderr.write(`fleet: ${id} started; .help lists what to send\n`)
        await repl({ request: (method, params) => box.request(method as never, params as never, { hold: false }) }, {
          input: process.stdin,
          output: process.stdout,
          errors: process.stderr,
          terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
          prompt: `${id}> `,
          signal: interrupt.signal,
        })
      } finally {
        process.off('SIGINT', onInterrupt)
        await release()
        await fleet.close()
      }
      return
    }
    throw new UsageError(verb === undefined ? 'box takes list, create, rm or repl' : `no command box ${verb}`)
  },

  async service(args) {
    const [verb, ...rest] = args
    if (verb !== 'list') throw new UsageError(verb === undefined ? 'service takes list' : `no command service ${verb}`)
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } })
    if (positionals.length > 0) throw new UsageError('service list takes no arguments')
    const fleet = await client()
    try {
      const services = await fleet.request('service.list', {})
      if (values.json === true) {
        process.stdout.write(`${JSON.stringify(services, null, 2)}\n`)
        return
      }
      table([['SERVICE', 'COMMANDS', 'WHAT IT IS'], ...services.map(service => [service.name, Object.keys(service.bins).join(' ') || '-', service.description])])
    } finally {
      await fleet.close()
    }
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
