#!/usr/bin/env node
/**
 * `fleet-notes`: serve the notes service (./service.ts) to fleet's gateway
 * for as long as it runs, its notebooks in a folder of its own.
 * @module @sleepymug/fleet-notes/main
 */

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Fleet, fleetHome } from '@sleepymug/fleet-sdk'
import { Notebooks } from './notebooks.ts'
import { notesService } from './service.ts'

const USAGE = `Usage: fleet-notes [--dir <dir>]

Serve the notes service to fleet's gateway, at $FLEET_SOCKET, or fleet.sock in
the fleet home, until interrupted: each box made with it has a notebook of its
own, kept in <dir>, by default notes/ in the fleet home.
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
    const client = await Fleet.connect({ log })
    await client.serve(notesService(new Notebooks(values.dir ?? join(fleetHome(), 'notes'))))
    log('serving the notes service')
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { resolve() })
    })
    await client.close()
  }
} catch (error) {
  process.stderr.write(`fleet-notes: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
