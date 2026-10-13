/**
 * The runtime of a tau's run in its box (./endpoint.ts), as the host runs
 * it, with each command as ./protocol.ts has it: `setup`, with the run's
 * call on stdin, which writes what the host needs of the run as JSON to
 * stdout, and `pack`, which writes the run's result to stdout. Why one
 * fails goes to stderr.
 * @module @sleepymug/fleet-box-runtime/tau/main
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pack, setup } from './endpoint.ts'
import { readTauCommand } from './protocol.ts'

try {
  const command = readTauCommand(process.argv.slice(2))
  if (command.command === 'setup') {
    process.stdout.write(`${JSON.stringify(await setup(process.stdin, command.offered))}\n`)
  } else {
    await pipeline(Readable.from(await pack(command.outcome)), process.stdout)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
