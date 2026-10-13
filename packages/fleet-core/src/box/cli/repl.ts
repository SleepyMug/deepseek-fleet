/**
 * The REPL of `fleet-box start`. Each line sends one method to the started
 * box's helper, as `<method> [<params as JSON>]`, and prints its result as
 * one line of JSON; a line that starts with a dot is one of the REPL's own
 * commands. Results go to the output, errors to the error stream, so piped
 * input gives clean output.
 * @module @sleepymug/fleet-core/box/cli/repl
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Method } from '@sleepymug/fleet-box-runtime/helper/protocol'
import { METHODS, type Box } from '../box.ts'
import { messageOf } from '../../util/error.ts'

/** What one line asks for. */
export type Line =
  | { kind: 'empty' }
  | { kind: 'command'; command: string }
  | { kind: 'request'; method: string; params: Record<string, unknown> }

/** The REPL's own commands, and what each does. */
const COMMANDS: Record<string, string> = {
  '.help': 'list the methods and commands',
  '.exit': 'leave, which stops the box; so do Ctrl+D and Ctrl+C',
}

const HELP = [
  '<method> [<params as JSON>]   send a method to the helper, such as: echo {"text":"hi"}',
  `methods: ${METHODS.join(', ')}`,
  ...Object.entries(COMMANDS).map(([command, what]) => `${command.padEnd(6)}  ${what}`),
].join('\n')

export interface ReplOptions {
  input: Readable
  /** Receives results, and the prompt and echo on a terminal. */
  output: Writable
  /** Receives errors. */
  errors: Writable
  /** Whether input and output are a terminal, which gets a prompt, line editing and completion. */
  terminal: boolean
  prompt?: string
  /** Leaves the REPL, without waiting for the request in progress. */
  signal?: AbortSignal
}

/**
 * Read lines until the input ends, `.exit`, or an interrupt.
 * @param box - the started box, or anything that answers requests as one does.
 */
export async function repl(box: Pick<Box, 'request'>, options: ReplOptions): Promise<void> {
  const { output, errors, terminal } = options
  const rl = createInterface({ input: options.input, output, terminal, prompt: options.prompt, completer: complete })
  const left = Promise.withResolvers<'left'>()
  const leave = (): void => {
    left.resolve('left')
    rl.close()
  }
  // Ctrl+C reaches readline as this on a terminal, and the signal otherwise.
  rl.on('SIGINT', leave)
  options.signal?.addEventListener('abort', leave, { once: true })
  if (options.signal?.aborted === true) leave()
  let closed = false
  rl.once('close', () => { closed = true })
  if (terminal) {
    // Ctrl+D on an empty line types `.exit`, which shows and waits its turn as a typed line does; readline,
    // whose listener runs after this one, then closes, as it does on Ctrl+D.
    options.input.prependListener('keypress', (_text: string | undefined, key: { ctrl?: boolean; name?: string } | undefined) => {
      if (key?.ctrl === true && key.name === 'd' && rl.line === '' && !closed) rl.write('.exit\n')
    })
  }
  const prompt = (): void => { if (terminal && !closed) rl.prompt() }

  const answer = async (line: Line): Promise<void> => {
    switch (line.kind) {
      case 'empty':
        return
      case 'command':
        if (line.command === '.help') output.write(`${HELP}\n`)
        else errors.write(`error: no command ${line.command}; .help lists them\n`)
        return
      case 'request':
        try {
          // The helper connection refuses a method it does not know, which is the check for a typed name.
          const value = await box.request(line.method as Method, line.params as never)
          output.write(`${JSON.stringify(value)}\n`)
        } catch (error) {
          errors.write(`error: ${messageOf(error)}\n`)
        }
    }
  }

  try {
    prompt()
    for await (const text of rl) {
      let line: Line
      try {
        line = parseLine(text)
      } catch (error) {
        errors.write(`error: ${messageOf(error)}\n`)
        prompt()
        continue
      }
      if (line.kind === 'command' && line.command === '.exit') break
      if (await Promise.race([answer(line), left.promise]) === 'left') break
      prompt()
    }
  } finally {
    options.signal?.removeEventListener('abort', leave)
    rl.close()
  }
}

/**
 * Read one line: blank, a command, or a method with its params.
 * @throws when the params are not a JSON object.
 */
export function parseLine(text: string): Line {
  const line = text.trim()
  if (line === '') return { kind: 'empty' }
  if (line.startsWith('.')) return { kind: 'command', command: line }
  const space = line.search(/\s/u)
  const method = space === -1 ? line : line.slice(0, space)
  const rest = space === -1 ? '' : line.slice(space).trim()
  let params: unknown = {}
  if (rest !== '') {
    try {
      params = JSON.parse(rest)
    } catch {
      throw new Error(`the params of ${method} are not JSON: ${rest}`)
    }
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error(`the params of ${method} are not a JSON object`)
  }
  return { kind: 'request', method, params: params as Record<string, unknown> }
}

/** Complete the first word: a method or a command. */
function complete(line: string): [string[], string] {
  if (/\s/u.test(line)) return [[], line]
  const words = [...METHODS, ...Object.keys(COMMANDS)]
  const hits = words.filter(word => word.startsWith(line))
  return [hits.length > 0 ? hits : words, line]
}
