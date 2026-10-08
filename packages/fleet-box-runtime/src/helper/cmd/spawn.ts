/**
 * The processes the helper runs for the host's `ctx.subprocess` (fleet-core's
 * world/subprocess.ts). Each starts in a session of its own, so its process
 * group holds it and whatever it starts, except what starts a session of its
 * own; `kill` ends that group, and so does the helper's exit. Whatever
 * escapes it dies when the box stops.
 * @module @sleepymug/fleet-box-runtime/helper/cmd/spawn
 */

import { spawn as start } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { EXECUTABLE_NOT_FOUND, type EventOf, type Methods } from '../protocol.ts'

type Params = Methods['spawn']['params']
type Result = Methods['spawn']['result']

/** How often a process group is checked for members left. */
const POLL_MS = 100

/** Where the helper's events go, and when the host has caught up with them. */
export interface Output {
  /** Send an event; false when the host has fallen behind. */
  send(event: EventOf<'spawn'>): boolean
  /** Run a listener each time the host catches up. */
  onDrain(listener: () => void): void
}

interface Running {
  group: number
  graceMs: number
  terminating: boolean
  /** Settles once the process has exited and its group is empty. */
  gone: Promise<void>
}

const running = new Map<string, Running>()
/** Output streams being forwarded, paused together while the host is behind. */
const streams = new Set<Readable>()
let paused = false
let draining = false

/**
 * Run a program in a session of its own, send what it writes, and answer
 * once it has exited and its output has ended, or its grace period has passed
 * since, when something it started keeps the output open.
 * @throws when it cannot start, such as for a missing program or folder.
 */
export async function spawn(params: Params, output: Output): Promise<Result> {
  const { process: id, argv, cwd, env, stdin, graceMs } = checked(params)
  if (running.has(id)) throw new Error(`process ${id} already exists`)
  if (!draining) {
    draining = true
    output.onDrain(() => {
      paused = false
      for (const stream of streams) stream.resume()
    })
  }
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value
  for (const [key, value] of Object.entries(env)) {
    if (value === null) Reflect.deleteProperty(environment, key)
    else environment[key] = value
  }
  const [program = '', ...args] = argv
  const child = start(program, args, { cwd, env: environment, detached: true, stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } catch (error) {
    // Node names the program when the folder is what is missing.
    const folder = await stat(cwd).then(info => info.isDirectory(), () => false)
    throw folder ? error : new Error(`the working folder ${cwd} does not exist in the box`)
  }
  // Later errors, such as signalling a process that has exited, change nothing.
  child.on('error', () => {})
  const group = child.pid as number
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  child.once('exit', (code, signal) => { exited.resolve({ code, signal }) })
  const record: Running = {
    group, graceMs, terminating: false,
    gone: exited.promise.then(() => untilEmpty(group)).finally(() => { running.delete(id) }),
  }
  running.set(id, record)
  if (stdin !== null) {
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  }
  const outputs = [forward(child.stdout as Readable, 'stdout', output), forward(child.stderr as Readable, 'stderr', output)]
  const { code, signal } = await exited.promise
  const drained = await Promise.race([Promise.all(outputs.map(([, closed]) => closed)).then(() => true), delay(graceMs, false)])
  if (!drained) for (const [stream] of outputs) stream.destroy()
  return { code, signal }
}

/** Start ending a process's group: SIGTERM, then SIGKILL after its grace period; nothing once it is gone. */
export function kill({ process: id }: Methods['kill']['params']): null {
  const record = running.get(text(id, 'process'))
  if (record === undefined || record.terminating) return null
  record.terminating = true
  signalGroup(record.group, 'SIGTERM')
  void Promise.race([record.gone.then(() => true), delay(record.graceMs, false)]).then((gone) => {
    if (!gone) signalGroup(record.group, 'SIGKILL')
  })
  return null
}

/** End every process group, as the helper exits: SIGTERM, then SIGKILL after the longest grace period. */
export async function killAll(): Promise<void> {
  const records = [...running.values()]
  for (const record of records) signalGroup(record.group, 'SIGTERM')
  await Promise.race([Promise.all(records.map(record => record.gone)), delay(Math.max(0, ...records.map(record => record.graceMs)))])
  for (const record of records) signalGroup(record.group, 'SIGKILL')
}

/** Where a program is: an absolute path that is an executable file, or a bare name on the PATH. */
export async function which({ command, env }: Methods['which']['params']): Promise<string> {
  const name = text(command, 'command')
  if (name === '') throw new TypeError('the command is empty')
  if (name.includes('/')) {
    if (!isAbsolute(name)) throw new TypeError(`${name} is a relative path; give an absolute path or a bare name`)
    if (await isExecutable(name)) return name
    throw notFound(name)
  }
  for (const folder of (env?.PATH ?? process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(folder)) continue
    const candidate = join(folder, name)
    if (await isExecutable(candidate)) return candidate
  }
  throw notFound(name)
}

/** Send a stream's bytes as they come, pausing every stream while the host is behind. */
function forward(stream: Readable, name: 'stdout' | 'stderr', output: Output): [Readable, Promise<void>] {
  streams.add(stream)
  if (paused) stream.pause()
  stream.on('data', (chunk: Buffer) => {
    if (output.send({ stream: name, data: chunk.toString('base64') }) || paused) return
    paused = true
    for (const each of streams) each.pause()
  })
  const closed = new Promise<void>((resolve) => {
    stream.once('close', () => {
      streams.delete(stream)
      resolve()
    })
  })
  return [stream, closed]
}

function checked(params: Params): Params {
  const { process: id, argv, cwd, env, stdin, graceMs } = (params ?? {}) as Partial<Params>
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === 'string')) {
    throw new TypeError('spawn takes an argv, a list of strings, the program first')
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('spawn takes a cwd, an absolute path')
  if (typeof env !== 'object' || env === null || !Object.values(env).every(value => value === null || typeof value === 'string')) {
    throw new TypeError('spawn takes an env, of strings or nulls')
  }
  if (stdin !== null && typeof stdin !== 'string') throw new TypeError('spawn takes a stdin, a string or null')
  if (!Number.isSafeInteger(graceMs) || (graceMs as number) <= 0) throw new TypeError('spawn takes a graceMs, a positive whole number')
  return { process: text(id, 'process'), argv, cwd, env, stdin, graceMs: graceMs as number }
}

async function untilEmpty(group: number): Promise<void> {
  while (groupExists(group)) await delay(POLL_MS)
}

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal)
  } catch {
    // The group is empty already.
  }
}

function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function notFound(command: string): Error {
  return Object.assign(new Error(`${command} was not found in the box`), { code: EXECUTABLE_NOT_FOUND })
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}
