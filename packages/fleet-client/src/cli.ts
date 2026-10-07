#!/usr/bin/env node
/**
 * `fleet`: start runs of taus, see where they are, wait for how they ended,
 * and cancel and delete them, through the tau service in the fleet host
 * (`dsh --profile fleet`), on its socket (./connection.ts); a run's call is
 * packed, and its result put at the caller's paths, here (./runs.ts).
 * @module fleet-client/cli
 */

import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { loadTau } from '@sleepymug/tau'
import type { Result, RunStatus, Started } from 'fleet-protocol/tau'
import { ConnectionLost, NoService, ask, defaultSocket } from './connection.ts'
import { finishRun, startRun } from './runs.ts'
import { UsageError, parseCall } from './call.ts'

const USAGE = `Usage: fleet <command>

Commands:
  start <tau-dir> [<name>=<value> | <name>:=<json>]...
                         start a run of the tau with this call, and print
                         its session's id, then the tau's prompt; the web UI
                         lists the session under this folder
  list                   list the runs: session, state, how each ended, tau
  status <session-id>    show a run as list does, and why it failed, if it did
  finish [--history <file>] <session-id>
                         wait until the run ends, put what it gave back at the
                         paths it was given, and print the agent's final text;
                         why it failed goes to stderr, with exit code 1;
                         --history writes the run's session's history to
                         <file>, an event of dsh's per line, failed or not
  cancel <session-id>    cancel the run's turn, which ends the run
  delete <session-id>    archive the run's session, remove its box, and forget it
  run [--history <file>] <tau-dir> [<name>=<value> | <name>:=<json>]...
                         start a run and finish it, as finish does; Ctrl-C
                         cancels the run, and Ctrl-C again leaves it running

A run is running until its agent is done, then ended, and finished once
finish has given back how it ended, which it does again each time, putting
what the run gave back at its out and inout files' paths again.

Calls: <name>=<value> gives the file <name> the path <value>, when tau.json
declares that file, and else the arg <name> the string <value>. <name>:=<json>
gives either as JSON: a file a path, or, for an in file, a list of paths; an
arg any JSON, as tau's docs/spec/calls.md has them. Relative paths are this
folder's. In a string of the args, \${<file>} is where the tau's agent sees
that file, as in 'start=\${site}/index.html'.

The tau service listens on $DSH_HOME/fleet/tau.sock, ~/.dsh/fleet/tau.sock
when DSH_HOME is not set.
`

const socket = defaultSocket()

/** The option of the commands that finish a run. */
const HISTORY = { history: { type: 'string' } } as const

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async start(args) {
    const started = await start(parseArgs({ args, allowPositionals: true }).positionals)
    process.stdout.write(`${started.sessionId}\n${started.prompt}${started.prompt.endsWith('\n') ? '' : '\n'}`)
  },
  async list(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    if (positionals.length > 0) throw new UsageError('list takes no arguments')
    for (const status of await ask(socket, { op: 'list' })) process.stdout.write(`${row(status)}\n`)
  },
  async status(args) {
    const status = await ask(socket, { op: 'status', sessionId: sessionOf('status', args) })
    process.stdout.write(`${row(status)}\n`)
    if (status.result?.failure !== undefined) process.stdout.write(`  ${status.result.failure}\n`)
  },
  async finish(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: HISTORY })
    if (positionals.length !== 1) throw new UsageError('finish takes the id of one session')
    report(await finish(positionals[0], values.history))
  },
  async cancel(args) {
    await ask(socket, { op: 'cancel', sessionId: sessionOf('cancel', args) })
  },
  async delete(args) {
    await ask(socket, { op: 'delete', sessionId: sessionOf('delete', args) })
  },
  async run(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: HISTORY })
    const { sessionId } = await start(positionals)
    process.stderr.write(`fleet: started ${sessionId}\n`)
    let cancelling = false
    const interrupt = (): void => {
      if (cancelling) process.exit(130)
      cancelling = true
      process.stderr.write(`fleet: cancelling ${sessionId}; Ctrl-C again leaves it running\n`)
      ask(socket, { op: 'cancel', sessionId }).catch((error: unknown) => { process.stderr.write(`fleet: ${message(error)}\n`) })
    }
    process.on('SIGINT', interrupt)
    try {
      report(await finish(sessionId, values.history))
    } finally {
      process.off('SIGINT', interrupt)
    }
  },
}

/** Start a run of the tau a command line names, with the call it gives. */
async function start(positionals: string[]): Promise<Started> {
  const [dir, ...callArgs] = positionals
  if (dir === undefined) throw new UsageError('give a tau directory, then its files and args')
  const tau = loadTau(dir)
  return await startRun(socket, dir, parseCall(callArgs, tau.files), process.cwd())
}

/** The one session's id a command takes. */
function sessionOf(command: string, args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  if (positionals.length !== 1) throw new UsageError(`${command} takes the id of one session`)
  return positionals[0]
}

/**
 * Wait until a run ends, put what it gave back at the caller's paths, and
 * its session's history at `history`, if given, and give back how it
 * ended. A finish can be asked again, so when the service
 * goes away before it answers, as when dsh restarts, it waits for it to come
 * back, and asks again.
 */
async function finish(sessionId: string, history?: string): Promise<Result> {
  let waiting = false
  for (;;) {
    try {
      return await finishRun(socket, sessionId, history)
    } catch (error) {
      if (!(error instanceof ConnectionLost || (waiting && error instanceof NoService))) throw error
      if (!waiting) process.stderr.write('fleet: lost the tau service; waiting for it to come back\n')
      waiting = true
      await delay(1000)
    }
  }
}

/** A run's result as a command reports it: the final text on stdout, and why it failed on stderr, with exit code 1. */
function report(result: Result): void {
  if (result.text !== '') process.stdout.write(`${result.text}${result.text.endsWith('\n') ? '' : '\n'}`)
  if (result.ok) return
  process.stderr.write(`fleet: ${String(result.failure)}\n`)
  process.exitCode = 1
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
