#!/usr/bin/env node
/**
 * `fleet-notes`: run the notes service (./service.ts) on the fleet host,
 * registered as long as it runs, its notebooks in a folder of its own,
 * until interrupted.
 * @module @sleepymug/fleet-notes/main
 */

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { FleetClient, fleetHome } from '@sleepymug/fleet-client'
import { Notebooks } from './notes.ts'
import { notesService } from './service.ts'

const USAGE = `Usage: fleet-notes [--dir <dir>]

Run the notes service on the fleet host, at $FLEET_SOCKET, or fleet.sock in the
fleet home, until interrupted: each box gets the notes command, its notebook
kept in <dir>, by default notes/ in the fleet home.
`

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help === true) {
    process.stdout.write(USAGE)
  } else if (positionals.length > 0) {
    process.stderr.write(`fleet-notes: takes no arguments\n${USAGE}`)
    process.exitCode = 2
  } else {
    const log = (message: string): void => { process.stderr.write(`fleet-notes: ${message}\n`) }
    const client = await FleetClient.connect({ log })
    await client.register(notesService(new Notebooks(values.dir ?? join(fleetHome(), 'notes'))))
    log('registered the notes service')
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { resolve() })
    })
    await client.close()
  }
} catch (error) {
  process.stderr.write(`fleet-notes: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
