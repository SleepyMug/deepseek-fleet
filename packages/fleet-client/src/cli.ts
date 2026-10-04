#!/usr/bin/env node
/**
 * `fleet`: set up a box for a run of a tau, and start, stop and delete its
 * session, through the tau service in the fleet host (`dsh --profile fleet`), on its
 * socket (./connection.ts).
 * @module fleet-client/cli
 */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadTau } from '@sleepymug/tau'
import type { Created } from 'fleet-protocol/tau'
import { defaultSocket, request, type Body } from './connection.ts'
import { UsageError, parseValues } from './values.ts'

const USAGE = `Usage: fleet <command>

Commands:
  create <tau-dir> [<name>=<value> | <name>:=<json>]...
                         set up a box for a run of the tau with these values,
                         and print the session's id, then the tau's prompt
  start <session-id>     start the session's box; the first start makes the
                         session, which the web UI lists under this folder,
                         and gives it the tau's prompt
  stop <session-id>      cancel the session's turn, and stop its box
  delete <session-id>    archive the session, remove its box, and forget it

Values: <name>=<value> gives a text, or, for a parameter whose type is a file,
a dir or a path, a handle of the mode tau.json declares, to the path <value>.
<name>:=<json> gives any value as JSON, as tau's docs/spec/values.md has them.
Relative paths are this folder's.

The tau service listens on $DSH_HOME/fleet/tau.sock, ~/.dsh/fleet/tau.sock
when DSH_HOME is not set.
`

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async create(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    const [dir, ...valueArgs] = positionals
    if (dir === undefined) throw new UsageError('create takes a tau directory, then the values')
    const tau = loadTau(dir)
    const values = parseValues(valueArgs, tau.params)
    const created = await send({ op: 'create', tauDir: resolve(dir), callerCwd: process.cwd(), values })
    if (created === null) throw new Error('fleet: the tau service answered create without a session')
    process.stdout.write(`${created.sessionId}\n${created.prompt}${created.prompt.endsWith('\n') ? '' : '\n'}`)
  },
  start: session('start'),
  stop: session('stop'),
  delete: session('delete'),
}

/** A command that takes one session's id. */
function session(op: 'start' | 'stop' | 'delete'): (args: string[]) => Promise<void> {
  return async (args) => {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    if (positionals.length !== 1) throw new UsageError(`${op} takes the id of one session`)
    await send({ op, sessionId: positionals[0] })
  }
}

/**
 * Send a request to the tau service.
 * @returns what it answers with; its error fails.
 */
async function send(body: Body): Promise<Created | null> {
  const response = await request(defaultSocket(), body)
  if (!response.ok) throw new Error(response.error)
  return response.value
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
