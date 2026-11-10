/**
 * dsh-tau's half of a run in its box (./endpoint.ts), as dsh-tau runs it,
 * with each command as ../protocol.ts has it: `setup`, with the run's call
 * on stdin, which writes what dsh-tau needs of the run as JSON to stdout,
 * and `pack`, which writes the run's result to stdout. Why one fails goes
 * to stderr.
 * @module @sleepymug/dsh-tau-box/box/main
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readTauCommand } from '../protocol.ts'
import { pack, setup } from './endpoint.ts'

try {
  const command = readTauCommand(process.argv.slice(2))
  if (command.command === 'setup') {
    process.stdout.write(`${JSON.stringify(await setup(process.stdin))}\n`)
  } else {
    await pipeline(Readable.from(await pack(command.outcome)), process.stdout)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
