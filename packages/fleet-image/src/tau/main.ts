/**
 * `node main.js place '<{"handles"}>'`, with a run's call on stdin, and
 * `node main.js pack '<{"outcome", "handles"}>'`, which writes the run's
 * result to stdout (./endpoint.ts). Why one fails goes to stderr.
 * @module fleet-image/tau/main
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pack, place } from './endpoint.ts'

const [command, json] = process.argv.slice(2)
try {
  const params = JSON.parse(json ?? '') as Record<string, unknown>
  if (!Array.isArray(params.handles)) throw new TypeError('the handles are missing')
  if (command === 'place') await place(process.stdin, params.handles)
  else if (command === 'pack') await pipeline(Readable.from(pack(params.outcome as Parameters<typeof pack>[0], params.handles)), process.stdout)
  else throw new TypeError(`no command ${String(command)}; place or pack`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
