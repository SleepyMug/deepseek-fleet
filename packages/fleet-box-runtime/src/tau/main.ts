/**
 * The runtime of a tau's run in its box (./endpoint.ts): `node main.js
 * setup '<{"offered"}>'`, with the run's call on stdin, which writes what
 * the host needs of the run as JSON to stdout, and `node main.js pack '<{"outcome"}>'`, which
 * writes the run's result to stdout. Why one fails goes to stderr.
 * @module @sleepymug/fleet-box-runtime/tau/main
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pack, setup } from './endpoint.ts'

const [command, json] = process.argv.slice(2)
try {
  if (command === 'setup') {
    const { offered } = JSON.parse(json ?? '') as { offered: Parameters<typeof setup>[1] }
    process.stdout.write(`${JSON.stringify(await setup(process.stdin, offered))}\n`)
  } else if (command === 'pack') {
    const { outcome } = JSON.parse(json ?? '') as { outcome: Parameters<typeof pack>[0] }
    await pipeline(Readable.from(await pack(outcome)), process.stdout)
  } else throw new TypeError(`no command ${String(command)}; setup or pack`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
