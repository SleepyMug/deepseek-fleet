#!/usr/bin/env node
/**
 * `fleet-trace <scenario.json> [out]`: run a scenario on a scratch fleet
 * host (./run.ts), and write what the model was sent to `out`, by default
 * /tmp/fleet-trace/<scenario's name>.
 * @module fleet-trace/cli
 */

import { basename, extname, join, resolve } from 'node:path'
import { runScenario } from './run.ts'

const [scenario, out] = process.argv.slice(2)
if (scenario === undefined || scenario.startsWith('-')) {
  process.stderr.write('usage: fleet-trace <scenario.json> [out]\n')
  process.exit(2)
}
const target = resolve(out ?? join('/tmp/fleet-trace', basename(scenario, extname(scenario))))
// An interrupted run cleans up before it exits: the session and its box, dsh, the scratch folder.
const interrupt = new AbortController()
process.once('SIGINT', () => { interrupt.abort() }).once('SIGTERM', () => { interrupt.abort() })
try {
  await runScenario(resolve(scenario), target, interrupt.signal)
  process.stdout.write(`${target}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = interrupt.signal.aborted ? 130 : 1
}
