#!/usr/bin/env node
/**
 * `fleet`: see the runs of taus on the tau service of the dsh host
 * fleet-core is installed in (`dsh web`), where they are, and what each
 * run's agent did, on the service's socket, as tau's `defaultFleetSocket`
 * finds it. A run is started, finished and released with tau's own command,
 * `tau --adaptor fleet` (tau's docs/spec/fleet.md).
 * @module @sleepymug/fleet-client/cli
 */

import { parseArgs } from 'node:util'
import { defaultFleetSocket, fleetSocket } from '@sleepymug/tau/adaptors'
import type { Answers, Request, RunStatus } from '@sleepymug/fleet-protocol/tau'

const USAGE = `Usage: fleet <command>

Commands:
  list                   list the runs: session, state, how each ended, tau
  status <run>           show a run as list does, then why it failed, if it
                         did, and its prompt
  history <run>          print the run's session's history, an event of dsh's
                         per line, whether it ended or not

A run is named by its session's id, or by its id as tau gives it,
fleet:<session-id>. A run is running until its agent is done, then ended,
and finished once tau's finish has given back how it ended.

Runs are started, finished and released with tau's command:
  tau run --adaptor fleet <tau-dir> --call <call.json>
  tau start --adaptor fleet <tau-dir> --call <call.json>
  tau finish | wait | release fleet:<session-id>

The tau service listens on $TAU_FLEET_SOCKET, or else $DSH_HOME/fleet/tau.sock,
~/.dsh/fleet/tau.sock when DSH_HOME is not set.
`

const service = fleetSocket(defaultFleetSocket())

/** A mistake in the command line, answered with a pointer to the usage. */
class UsageError extends Error {}

async function ask<O extends Request['op']>(request: Request & { op: O }): Promise<Answers[O]> {
  return (await service.exchange(request)).value as Answers[O]
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async list(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    if (positionals.length > 0) throw new UsageError('list takes no arguments')
    for (const status of await ask({ op: 'list' })) process.stdout.write(`${row(status)}\n`)
  },
  async status(args) {
    const status = await ask({ op: 'status', id: runOf('status', args) })
    process.stdout.write(`${row(status)}\n`)
    if (status.result?.failure !== undefined) process.stdout.write(`  ${status.result.failure}\n`)
    process.stdout.write(`${status.prompt}${status.prompt.endsWith('\n') ? '' : '\n'}`)
  },
  async history(args) {
    for (const event of await ask({ op: 'history', id: runOf('history', args) })) process.stdout.write(`${JSON.stringify(event)}\n`)
  },
}

/** The one run a command takes, by its session's id. */
function runOf(command: string, args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  if (positionals.length !== 1) throw new UsageError(`${command} takes one run`)
  const [run] = positionals
  return run.startsWith('fleet:') ? run.slice('fleet:'.length) : run
}

/** A run as list shows it. */
function row(status: RunStatus): string {
  const outcome = status.result === undefined ? '-' : status.result.ok ? 'ok' : 'failed'
  return `${status.sessionId}  ${status.state.padEnd(8)}  ${outcome.padEnd(6)}  ${status.title}`
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
  await commands[command](args)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  const usage = error instanceof UsageError || (error as { code?: unknown }).code?.toString().startsWith('ERR_PARSE_ARGS') === true
  process.stderr.write(`fleet: ${message(error)}${usage ? '\nRun `fleet --help` for the commands.' : ''}\n`)
  process.exitCode = usage ? 2 : 1
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // The service's errors carry the prefix already.
  return text.startsWith('fleet: ') ? text.slice('fleet: '.length) : text
}
