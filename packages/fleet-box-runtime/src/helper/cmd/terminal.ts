/**
 * The terminals the helper runs for the host's `ctx.subprocess` (fleet-core's
 * world/terminal.ts), such as the web UI's sidebar terminal: a program on a
 * pseudo-terminal in the box, through node-pty, in a session of its own,
 * which it leads. The kernel tells which process group is in the terminal's
 * foreground (/proc/<pid>/stat), and which processes are in its session,
 * so the helper signals the one and ends the other, background jobs
 * included. node-pty is loaded when the first terminal starts, so a box
 * without it fails only terminals.
 * @module fleet-box-runtime/helper/cmd/terminal
 */

import { readdir, readFile } from 'node:fs/promises'
import { constants } from 'node:os'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { EventOf, Methods } from '../protocol.ts'

type Params<M extends keyof Methods> = Methods[M]['params']

/** How often a terminal's session is checked for members left. */
const POLL_MS = 100

/** node-pty's terminal, as far as the helper uses it. */
interface Pty {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
}

interface Running {
  pty: Pty
  graceMs: number
  /** Settles once the program has exited. */
  exited: Promise<void>
  ending: Promise<void> | undefined
}

const running = new Map<string, Running>()
let nodePty: Promise<{ spawn(file: string, args: string[], options: object): Pty }> | undefined

/**
 * Run a program on a terminal of its own, send `started` and then what the
 * terminal writes, and answer once it has exited and its output is sent.
 * @throws when it cannot start, such as for a missing program or folder.
 */
export async function terminal(
  params: Params<'terminal'>,
  output: { send(event: EventOf<'terminal'>): boolean; onDrain(listener: () => void): void },
): Promise<Methods['terminal']['result']> {
  const { terminal: id, argv, cwd, env, cols, rows, term, graceMs } = checked(params)
  if (running.has(id)) throw new Error(`terminal ${id} already exists`)
  nodePty ??= import('node-pty') as unknown as Promise<{ spawn(file: string, args: string[], options: object): Pty }>
  const { spawn } = await nodePty
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value
  for (const [key, value] of Object.entries(env)) {
    if (value === null) Reflect.deleteProperty(environment, key)
    else environment[key] = value
  }
  environment.TERM = term
  const [program = '', ...args] = argv
  const pty = spawn(program, args, { name: term, cols, rows, cwd, env: environment })
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  const record: Running = { pty, graceMs, exited: exited.promise.then(() => {}), ending: undefined }
  running.set(id, record)
  output.send({ kind: 'started', pid: pty.pid })
  pty.onData((data) => {
    if (!output.send({ kind: 'data', data: Buffer.from(data, 'utf8').toString('base64') })) {
      pty.pause()
      output.onDrain(() => { pty.resume() })
    }
  })
  pty.onExit(({ exitCode, signal }) => {
    exited.resolve(signal !== undefined && signal !== 0 ? { code: null, signal: signalName(signal) } : { code: exitCode, signal: null })
  })
  try {
    return await exited.promise
  } finally {
    // What the program left running stays the terminal's until `terminal.end`.
    void record.exited.then(() => untilEmpty(pty.pid)).then(() => { if (running.get(id) === record) running.delete(id) })
  }
}

export function terminalWrite({ terminal: id, data }: Params<'terminal.write'>): null {
  if (typeof data !== 'string') throw new TypeError('data must be a string')
  find(id).pty.write(data)
  return null
}

export function terminalResize({ terminal: id, cols, rows }: Params<'terminal.resize'>): null {
  find(id).pty.resize(size(cols, 'cols'), size(rows, 'rows'))
  return null
}

export async function terminalForeground({ terminal: id }: Params<'terminal.foreground'>): Promise<Methods['terminal.foreground']['result']> {
  const group = await foregroundGroup(find(id).pty.pid)
  return group === undefined ? null : { processGroupId: group }
}

export async function terminalSignal({ terminal: id, signal }: Params<'terminal.signal'>): Promise<number> {
  if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'].includes(signal)) throw new TypeError(`${String(signal)} is not a terminal signal`)
  const group = await foregroundGroup(find(id).pty.pid)
  if (group === undefined) throw new Error(`terminal ${id} has no foreground process group`)
  process.kill(-group, signal)
  return group
}

/** End every process of a terminal's session, and answer once none is left; a terminal not there has ended. */
export async function terminalEnd({ terminal: id }: Params<'terminal.end'>): Promise<null> {
  const record = running.get(text(id, 'terminal'))
  if (record === undefined) return null
  record.ending ??= (async () => {
    const session = record.pty.pid
    await signalSession(session, 'SIGHUP')
    await signalSession(session, 'SIGTERM')
    const empty = await Promise.race([untilEmpty(session).then(() => true), delay(record.graceMs, false)])
    if (!empty) await signalSession(session, 'SIGKILL')
    await untilEmpty(session)
    await record.exited
    if (running.get(id) === record) running.delete(id)
  })()
  await record.ending
  return null
}

/** End every terminal, as the helper exits. */
export async function endAll(): Promise<void> {
  await Promise.allSettled([...running.keys()].map(id => terminalEnd({ terminal: id })))
}

function find(id: string): Running {
  const record = running.get(text(id, 'terminal'))
  if (record === undefined) throw new Error(`no terminal ${id}`)
  return record
}

/** The fields of /proc/<pid>/stat after the program's name, which may hold spaces. */
async function stat(pid: number | string): Promise<string[] | undefined> {
  const line = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined)
  return line?.slice(line.lastIndexOf(')') + 2).split(' ')
}

/** The terminal's foreground process group, which the kernel keeps for the process it runs. */
async function foregroundGroup(pid: number): Promise<number | undefined> {
  const tpgid = Number((await stat(pid))?.[5])
  return Number.isSafeInteger(tpgid) && tpgid > 0 ? tpgid : undefined
}

/** The processes in a session. */
async function members(session: number): Promise<number[]> {
  const pids = (await readdir('/proc')).filter(name => /^\d+$/u.test(name))
  const found = await Promise.all(pids.map(async pid => Number((await stat(pid))?.[3]) === session ? Number(pid) : undefined))
  return found.filter((pid): pid is number => pid !== undefined)
}

async function signalSession(session: number, signal: NodeJS.Signals): Promise<void> {
  for (const pid of await members(session)) {
    try {
      process.kill(pid, signal)
    } catch {
      // It has exited already.
    }
  }
}

async function untilEmpty(session: number): Promise<void> {
  while ((await members(session)).length > 0) await delay(POLL_MS)
}

function signalName(signal: number): string {
  return Object.entries(constants.signals).find(([, number]) => number === signal)?.[0] ?? String(signal)
}

function checked(params: Params<'terminal'>): Params<'terminal'> {
  const { terminal: id, argv, cwd, env, cols, rows, term, graceMs } = (params ?? {}) as Partial<Params<'terminal'>>
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === 'string')) {
    throw new TypeError('terminal takes an argv, a list of strings, the program first')
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('terminal takes a cwd, an absolute path')
  if (typeof env !== 'object' || env === null || !Object.values(env).every(value => value === null || typeof value === 'string')) {
    throw new TypeError('terminal takes an env, of strings or nulls')
  }
  if (!Number.isSafeInteger(graceMs) || (graceMs as number) <= 0) throw new TypeError('terminal takes a graceMs, a positive whole number')
  return { terminal: text(id, 'terminal'), argv, cwd, env, cols: size(cols, 'cols'), rows: size(rows, 'rows'), term: text(term, 'term'), graceMs: graceMs as number }
}

function size(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${name} must be a positive whole number`)
  return value as number
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}
