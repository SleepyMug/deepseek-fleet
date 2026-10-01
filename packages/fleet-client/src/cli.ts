#!/usr/bin/env node
/**
 * `fleet`: run agents in the fleet host's containers from the command line,
 * through the host's control socket. An agent is a directory in the tau
 * format, as for pi-run (@sleepymug/tau's SPEC.md): `fleet run <agent-dir>
 * [args...]` has the host fill its PROMPT.md with the arguments its tau.json
 * declares and give it to a new session of a project, the current folder or
 * the one `--project` names; the session gets the agent's skills, and the
 * APIs it declares, and works in a folder of its container's own, with the
 * caller's files only as its arguments give them. `fleet run -p <prompt>`
 * gives a session a prompt as it is, without an agent directory, and its
 * container mounts the project to work in. Either way the session gets
 * TypeScript tools that run programs in its container. The session is an
 * ordinary one of the fleet host, so the web UI lists it under its project,
 * and a person can follow or steer it there.
 *
 * A run is one-shot, as a tau's is: its session gets its task, and no
 * later message from the command. `run` and `wait` wait until the session is
 * idle, print only the last answer, exit 0 when the last turn completed and
 * 1 otherwise, and stop the session's container, which its next use starts
 * again. The session id is never printed: `run --sid-file <file>` writes it
 * to a file once its task is accepted. With `--async`, `run` returns once
 * the task is accepted. Ctrl-C cancels the turn being waited on; a second
 * one leaves it.
 *
 * `fleet setup image` sets this machine up for the host instead, without
 * it: it builds the session image fleet-box uses (./setup/image.ts). In the
 * fleet checkout, `pnpm image` builds the workspace, then runs it. Signing
 * in to a model provider happens in dsh, in a profile of its own
 * (fleet-signin's app).
 * @module fleet-client/cli
 */

import { accessSync, constants, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { DEFAULT_IMAGE } from 'fleet-image/helper/image'
import { PROTOCOL_VERSION, dshHome, lineReader, socketPath } from 'fleet-protocol/control'
import type { Frame, Op, Outcome, Request, Results, Task } from 'fleet-protocol/control'
import { agentEnv } from './agent-env.ts'
import { UsageError, parseOptions } from './options.ts'
import { buildImage } from './setup/image.ts'

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2
const EXIT_INTERRUPTED = 130

const USAGE = [
  'Usage: fleet <command>',
  '  run [options] <agent-dir> [args...]         run an agent directory (tau format) in a new session',
  '  run [options] -p <prompt>                   run a new session on a prompt, without an agent directory',
  '      --project <dir>                         the project the web UI lists it under, which a prompt run works in;',
  '                                              default: this folder',
  '      --sid-file <file>                       write the session id to <file> once the task is accepted',
  '      --async                                 return once the task is accepted',
  '  wait <session>                              wait until a session is idle and print its last answer',
  '  ls                                          list the sessions',
  '  cancel <session>                            cancel a session\'s running turn',
  '  stop <session>                              stop a session\'s container unless the session is busy',
  '  rm [--force] <session>                      archive a session and remove its container;',
  '                                              --force stops what it still runs',
  '  check <agent-dir> [args...]                 report what would keep an agent directory from running,',
  '                                              its APIs checked against fleet\'s implementations;',
  '                                              with arguments, bind them too',
  '  apis [name]                                 list the APIs fleet implements, or print one\'s declarations',
  '  setup image [--from <image>] [--tag <tag>]  build the session image: fleet\'s runtime on its own environment,',
  `                                              or on the --from image; tagged ${DEFAULT_IMAGE}, which fleet-box uses,`,
  '                                              or --tag, which its `image` setting must name',
  '',
  'Options come before the other arguments. run and wait print only the answer, exit 0',
  'when the turn completed and 1 otherwise, and stop the session\'s container. Ctrl-C cancels',
  'the turn they wait on.',
].join('\n')

const SOCKET = socketPath(dshHome())
const DOCKER = 'docker'

/** A failure the fleet host reported. */
class HostError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args
  switch (command) {
    case 'run': return run(rest)
    case 'wait': {
      const session = only(rest, 'wait')
      return attend({ op: 'wait', session }, { session })
    }
    case 'ls': return list(rest)
    case 'cancel':
      await call({ op: 'cancel', session: only(rest, 'cancel') })
      return EXIT_OK
    case 'stop': return stop(only(rest, 'stop'))
    case 'rm': {
      const { flags, positional } = parseOptions(rest, { '--force': 'flag' })
      await call({ op: 'archive', session: only(positional, 'rm'), force: flags.has('--force') })
      return EXIT_OK
    }
    case 'check': return check(rest)
    case 'apis': return apis(rest)
    case 'setup': return setup(rest)
    case '--help':
    case '-h':
      say(USAGE)
      return EXIT_OK
    default:
      throw new UsageError(command === undefined ? '' : `unknown command ${command}`)
  }
}

async function run(args: readonly string[]): Promise<number> {
  const { flags, values, positional } = parseOptions(args, { '--async': 'flag', '--project': 'value', '--sid-file': 'value', '-p': 'value' })
  const request = { op: 'run', task: task(positional, values.get('-p')), cwd: projectDir(values.get('--project') ?? process.cwd()) } as const
  const sidFile = sidFilePath(values.get('--sid-file'))
  if (flags.has('--async')) {
    const { session } = await call({ ...request, wait: false })
    if (sidFile !== undefined) writeSid(sidFile, session)
    return EXIT_OK
  }
  return attend({ ...request, wait: true }, { sidFile })
}

/**
 * What a run asks: `-p`'s prompt as it is, which dsh titles from its words,
 * or an agent directory with its arguments, which the host reads and checks,
 * and the values of the variables the agent's tau.json lists.
 */
function task(positional: readonly string[], prompt: string | undefined): Task {
  if (prompt !== undefined) {
    if (positional.length > 0) throw new UsageError(`-p takes the whole prompt as one argument; quote it (${positional[0]} follows it)`)
    if (prompt.trim() === '') throw new Error('fleet: the prompt is empty')
    return { prompt }
  }
  const [dir, ...args] = positional
  if (dir === undefined) throw new UsageError('run needs an agent directory, or -p and a prompt')
  const agent = resolve(dir)
  return { agent, args, callerCwd: process.cwd(), env: agentEnv(agent, process.env) }
}

async function check(args: readonly string[]): Promise<number> {
  const { positional } = parseOptions(args, {})
  const [dir, ...agentArgs] = positional
  if (dir === undefined) throw new UsageError('check needs an agent directory')
  const agent = resolve(dir)
  const { problems } = await call({
    op: 'check', agent, args: agentArgs, bind: agentArgs.length > 0, callerCwd: process.cwd(), env: agentEnv(agent, process.env),
  })
  if (problems.length === 0) {
    process.stdout.write('ok\n')
    return EXIT_OK
  }
  for (const problem of problems) process.stdout.write(`${problem}\n`)
  return EXIT_FAILED
}

async function apis(args: readonly string[]): Promise<number> {
  if (args.length > 1) throw new UsageError('apis takes at most one API name')
  const { apis: rows } = await call({ op: 'apis' })
  const [name] = args
  if (name === undefined) {
    for (const row of rows) {
      const missing = row.missing.length === 0 ? '' : ` (needs the backend ${row.missing.join(', ')}, which no fleet plugin provides now)`
      process.stdout.write(`${row.name}  ${row.description?.replace(/\s+/gu, ' ').trim() ?? '-'}${missing}\n`)
    }
    return EXIT_OK
  }
  const row = rows.find(candidate => candidate.name === name)
  if (row === undefined) throw new Error(`fleet: fleet has no implementation of the API ${name}`)
  // What a tau copies into its api/<name>.d.ts.
  process.stdout.write(row.declarations.endsWith('\n') ? row.declarations : `${row.declarations}\n`)
  return EXIT_OK
}

/** What the host needs on this machine, which it cannot make itself: the session image. */
async function setup(args: readonly string[]): Promise<number> {
  const [part, ...rest] = args
  if (part !== 'image') throw new UsageError(part === undefined ? 'setup needs a part, image' : `unknown setup part ${part}`)
  const { values, positional } = parseOptions(rest, { '--from': 'value', '--tag': 'value' })
  if (positional.length > 0) throw new UsageError('setup image takes only options')
  const from = values.get('--from')
  await buildImage({ docker: DOCKER, tag: values.get('--tag') ?? DEFAULT_IMAGE, ...from === undefined ? {} : { from }, log: say })
  return EXIT_OK
}

/** The real path of a project, the folder dsh registers as the workspace of the session. */
function projectDir(dir: string): string {
  let path: string
  try {
    path = realpathSync(resolve(dir))
  } catch {
    throw new Error(`fleet: there is no folder ${dir}`)
  }
  if (!statSync(path).isDirectory()) throw new Error(`fleet: ${dir} is not a folder`)
  return path
}

/** Where to write the session id, checked before any session starts. */
function sidFilePath(file: string | undefined): string | undefined {
  if (file === undefined) return undefined
  const path = resolve(file)
  try {
    accessSync(dirname(path), constants.W_OK)
  } catch {
    throw new Error(`fleet: cannot write the session id to ${file}, since its folder is missing or not writable`)
  }
  return path
}

function writeSid(path: string, session: string): void {
  try {
    writeFileSync(path, `${session}\n`)
  } catch (error) {
    throw new Error(`fleet: could not write the session id to ${path}: ${describe(error)}`)
  }
}

async function list(args: readonly string[]): Promise<number> {
  if (args.length > 0) throw new UsageError('ls takes no arguments')
  const { sessions } = await call({ op: 'list' })
  for (const row of sessions) {
    const fields = [row.session, row.running ? 'running' : 'idle   ', formatTime(row.updatedAt), row.title ?? '-', row.cwd ?? '-']
    process.stdout.write(`${fields.join('  ')}\n`)
  }
  return EXIT_OK
}

async function stop(session: string): Promise<number> {
  const result = await call({ op: 'stop', session })
  if (result.stopped) return EXIT_OK
  say(`fleet: ${session} is busy (${result.activity.join(', ')}), so its container keeps running`)
  return EXIT_FAILED
}

/**
 * Make a request that waits until a session is idle, report the outcome, and
 * stop the session's container. Ctrl-C cancels the turn being waited on, and
 * a second one leaves without waiting.
 * @param known.session - the session, when the request names it; a `run` learns it from the host.
 * @param known.sidFile - where to write the session a `run` learns, as soon as it does.
 */
async function attend(request: Extract<Request, { op: 'run' | 'wait' }>, known: { session?: string; sidFile?: string }): Promise<number> {
  let session = known.session
  let interrupted = false
  let unrecorded = false
  const cancel = (id: string): void => {
    call({ op: 'cancel', session: id }).catch((error: unknown) => { say(`fleet: could not cancel ${id}: ${describe(error)}`) })
  }
  const interrupt = (): void => {
    if (interrupted) process.exit(EXIT_INTERRUPTED)
    interrupted = true
    say('fleet: cancelling; press Ctrl-C again to leave it running')
    if (session !== undefined) cancel(session)
  }
  process.on('SIGINT', interrupt)
  try {
    const result = await call(request, (id) => {
      session = id
      if (known.sidFile !== undefined) {
        try {
          writeSid(known.sidFile, id)
        } catch (error) {
          // The run goes on, and the caller learns from the exit code that the id is missing.
          unrecorded = true
          say(describe(error))
        }
      }
      if (interrupted) cancel(id)
    })
    const outcome = (result as { outcome?: Outcome }).outcome
    if (outcome === undefined) throw new Error('fleet: the host answered without an outcome')
    // The answer first: stopping waits its turn behind the container's other operations.
    report(outcome)
    if (session !== undefined) await stopQuietly(session)
    if (interrupted) return EXIT_INTERRUPTED
    return outcome.reason === 'completed' && outcome.outputs === undefined && !unrecorded ? EXIT_OK : EXIT_FAILED
  } finally {
    process.off('SIGINT', interrupt)
  }
}

/** Stop a session's container once done with it; a failure only warns, since the outcome stands. */
async function stopQuietly(session: string): Promise<void> {
  try {
    const result = await call({ op: 'stop', session })
    if (!result.stopped) say(`fleet: ${session} is busy again (${result.activity.join(', ')}), so its container keeps running`)
  } catch (error) {
    say(`fleet: could not stop the container of ${session}: ${describe(error)}`)
  }
}

function report(outcome: Outcome): void {
  if (outcome.text !== '') process.stdout.write(`${outcome.text}\n`)
  if (outcome.error !== undefined) say(`fleet: ${outcome.error.code}: ${outcome.error.message}`)
  else if (outcome.reason === null) say('fleet: the session has not finished a turn')
  else if (outcome.reason !== 'completed') say(`fleet: the turn ended ${outcome.reason}`)
  if (outcome.outputs !== undefined) say(`fleet: the run did not give back its outputs:\n  ${outcome.outputs.join('\n  ')}`)
}

/**
 * Send one request to the fleet host and read its answer.
 * @param onSession - told the session of a `session` frame.
 */
function call<K extends Op>(request: Extract<Request, { op: K }>, onSession?: (session: string) => void): Promise<Results[K]> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      finish()
      socket.destroy()
    }
    const socket = createConnection(SOCKET)
    socket.once('connect', () => { socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...request })}\n`) })
    const read = lineReader((line) => {
      const frame = JSON.parse(line) as Frame
      if (frame.type === 'session') onSession?.(frame.session)
      else if (frame.type === 'result') settle(() => { resolvePromise(frame.value as Results[K]) })
      else settle(() => { reject(new HostError(frame.code, frame.message)) })
    }, Number.POSITIVE_INFINITY)
    socket.on('data', (chunk: Buffer) => {
      try {
        read(chunk)
      } catch (error) {
        settle(() => { reject(new Error(`fleet: the fleet host sent an unreadable answer: ${describe(error)}`)) })
      }
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle(() => {
        reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new Error(`fleet: the fleet host is not running, since nothing serves ${SOCKET}; start it with \`dsh --profile fleet\``)
          : error)
      })
    })
    socket.once('close', () => { settle(() => { reject(new Error('fleet: the fleet host closed the connection without answering')) }) })
  })
}

/** The one session argument of a command. */
function only(args: readonly string[], command: string): string {
  if (args.length !== 1 || args[0] === '') throw new UsageError(`${command} needs one session`)
  return args[0]!
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function describe(error: unknown): string {
  if (error instanceof HostError) return `${error.message} (${error.code})`
  return error instanceof Error ? error.message : String(error)
}

function say(line: string): void {
  process.stderr.write(`${line}\n`)
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError) {
    if (error.message !== '') say(`fleet: ${error.message}`)
    say(USAGE)
    process.exitCode = EXIT_USAGE
  } else {
    const text = describe(error)
    say(text.startsWith('fleet: ') ? text : `fleet: ${text}`)
    process.exitCode = EXIT_FAILED
  }
}
