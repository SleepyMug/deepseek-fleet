#!/usr/bin/env node
/**
 * `fleet-box`: create, list, delete and start boxes, and copy files and
 * folders in and folders out of them, from a shell, to show and debug a box and its helper. `start` starts a box and enters a REPL
 * that sends methods to its helper (./repl.ts), and stops the box when the
 * REPL is left.
 * @module @sleepymug/fleet-core/box/cli/main
 */

import { parseArgs } from 'node:util'
import { Box } from '../box.ts'
import { messageOf } from '../../util/error.ts'
import { repl } from './repl.ts'

const USAGE = `Usage: fleet-box <command>

Commands:
  create [--image <image>] [--name <name>]   create a box, stopped, and print its name
  list                                       list the boxes
  delete <name>...                           remove boxes, running or not
  copy-in <name> <from> <to>                 copy host file <from> to path <to> in the box,
                                             or the contents of host folder <from> into
                                             folder <to> in the box, running or not
  copy-out <name> <from> <to>                copy the contents of folder <from> in the box
                                             into host folder <to>, running or not
  start <name>                               start a box and send methods to its helper
                                             from a REPL; leaving the REPL stops the box
`

/** A mistake in the command line, answered with a pointer to the usage. */
class UsageError extends Error {}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async create(args) {
    const { values } = parseArgs({ args, options: { image: { type: 'string' }, name: { type: 'string' } } })
    const box = await Box.create({ image: values.image, name: values.name })
    process.stdout.write(`${box.container}\n`)
  },

  async list(args) {
    parseArgs({ args })
    const rows = [['NAME', 'STATUS', 'IMAGE'], ...(await Box.list()).map(box => [box.name, box.status, box.image])]
    const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)))
    for (const row of rows) {
      process.stdout.write(`${row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column])).join('  ')}\n`)
    }
  },

  async delete(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    if (positionals.length === 0) throw new UsageError('delete takes the names of the boxes to remove')
    let failed = false
    for (const name of positionals) {
      try {
        await (await Box.open(name)).remove()
      } catch (error) {
        process.stderr.write(`${messageOf(error)}\n`)
        failed = true
      }
    }
    if (failed) process.exitCode = 1
  },

  async 'copy-in'(args) {
    const [name, from, to] = exactly(args, 3, 'copy-in takes a box, a host file or folder and a path in the box')
    await (await Box.open(name)).copyIn(from, to)
  },

  async 'copy-out'(args) {
    const [name, from, to] = exactly(args, 3, 'copy-out takes a box, a folder in the box and a host folder')
    await (await Box.open(name)).copyOut(from, to)
  },

  async start(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    if (positionals.length !== 1) throw new UsageError('start takes the name of one box')
    const [name] = positionals
    const box = await Box.open(name)
    await box.start()
    const interrupt = new AbortController()
    const onInterrupt = (): void => { interrupt.abort() }
    process.on('SIGINT', onInterrupt)
    try {
      process.stderr.write(`fleet-box: ${name} started; .help lists what to send\n`)
      await repl(box, {
        input: process.stdin,
        output: process.stdout,
        errors: process.stderr,
        terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
        prompt: `${name}> `,
        signal: interrupt.signal,
      })
    } finally {
      process.off('SIGINT', onInterrupt)
      await box.stop()
      process.stderr.write(`fleet-box: ${name} stopped\n`)
    }
  },
}

/** The positionals of a command that takes `count` of them, and no options. */
function exactly(args: string[], count: number, usage: string): string[] {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  if (positionals.length !== count) throw new UsageError(usage)
  return positionals
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
  process.stderr.write(`fleet-box: ${messageOf(error)}${usage ? '\nRun `fleet-box --help` for the commands.' : ''}\n`)
  process.exitCode = usage ? 2 : 1
}
