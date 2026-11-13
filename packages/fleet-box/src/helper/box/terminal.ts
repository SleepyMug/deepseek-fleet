/**
 * The terminals the helper runs, each a call of `Box.Terminal`: a program
 * on a pseudo-terminal in the box, through node-pty, in a session it
 * leads. The kernel tells which process group holds the terminal's
 * foreground (/proc/<pid>/stat), and which processes are in its session,
 * so the helper signals the one and ends the other, background jobs
 * included, and tells whether the terminal is idle: a shell alone in its
 * session, in the foreground and asleep, waits at its prompt, as far as the
 * kernel can tell, though a loop of the shell's builtins that sleeps looks
 * the same. node-pty is loaded as the first terminal starts, so a box
 * without it fails only terminals.
 * @module @sleepymug/fleet-box/helper/box/terminal
 */

import { readdir, readFile, stat as statPath } from 'node:fs/promises'
import { constants } from 'node:os'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect'
import { type Exit, StartedSchema, type TerminalRequest, type TerminalResponse, TerminalResponseSchema, TerminalStatusSchema } from '@sleepymug/fleet-protocol/box'
import type { BoxLayout } from '@sleepymug/fleet-protocol/layout'
import { Channel } from '../channel.ts'
import { invalid } from '../errors.ts'
import { programEnvironment } from './env.ts'
import { exitOf, signalOf } from './processes.ts'

/** How long a session's processes have after SIGTERM before SIGKILL, unless the call says. */
const DEFAULT_GRACE_MS = 2000
/** How often a session is checked for members left. */
const POLL_MS = 100
/** The signals a terminal's foreground takes. */
const TERMINAL_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'])

/** node-pty's terminal, as far as the helper uses it. */
interface Pty {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
}

type NodePty = { spawn(file: string, args: string[], options: object): Pty }

/** A session being run, as the helper's end ends it. */
interface Session {
  readonly id: number
  readonly graceMs: number
}

/** The terminals of one helper, which end with it. */
export class Terminals {
  private readonly sessions = new Set<Session>()
  private nodePty: Promise<NodePty> | undefined

  /** @param env - the box's environment, which each terminal's program starts from. */
  constructor(private readonly env: Readonly<Record<string, string>>, private readonly layout: BoxLayout) {}

  /** Run a terminal, as `Box.Terminal` has it. */
  async *run(requests: AsyncIterable<TerminalRequest>, ctx: HandlerContext): AsyncGenerator<TerminalResponse> {
    const iterator = requests[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done === true || first.value.request.case !== 'start') throw invalid('a terminal starts with what to run')
    const { program, size, term, graceMs } = first.value.request.value
    const [file, ...args] = program?.argv ?? []
    if (file === undefined || file === '') throw invalid('a program is its argv, the program first')
    const cwd = program?.cwd === undefined || program.cwd === '' ? '/' : program.cwd
    if (!isAbsolute(cwd)) throw invalid(`the working folder ${cwd} is not an absolute path`)
    if (!(await statPath(cwd).then(info => info.isDirectory(), () => false))) {
      throw new ConnectError(`the working folder ${cwd} is not a folder in the box`, Code.FailedPrecondition)
    }
    this.nodePty ??= import('node-pty') as unknown as Promise<NodePty>
    const { spawn } = await this.nodePty.catch((error: unknown) => {
      this.nodePty = undefined
      throw new ConnectError(`the box has no terminals: ${error instanceof Error ? error.message : String(error)}`, Code.Unimplemented)
    })
    const env = programEnvironment(this.env, program?.env ?? {}, program?.unsetEnv ?? [], this.layout)
    env.TERM = term === '' ? 'xterm-256color' : term
    const pty = spawn(file, args, { name: env.TERM, cols: dimension(size?.cols, 80), rows: dimension(size?.rows, 24), cwd, env })
    const session: Session = { id: pty.pid, graceMs: graceMs === 0 ? DEFAULT_GRACE_MS : graceMs }
    this.sessions.add(session)
    const out = new Channel<TerminalResponse>()
    const respond = (response: MessageInitShape<typeof TerminalResponseSchema>['response']): boolean => out.push(create(TerminalResponseSchema, { response }))
    respond({ case: 'started', value: create(StartedSchema, { pid: pty.pid }) })
    pty.onData((data) => {
      if (!respond({ case: 'output', value: Buffer.from(data, 'utf8') })) {
        pty.pause()
        out.drained(() => { pty.resume() })
      }
    })
    const exited = new Promise<Exit>((resolve) => {
      pty.onExit(({ exitCode, signal }) => {
        resolve(signal !== undefined && signal !== 0 ? exitOf(null, signalName(signal)) : exitOf(exitCode, null))
      })
    })
    let ending: Promise<void> | undefined
    const endSession = (): Promise<void> => {
      ending ??= endAll(session).finally(() => { this.sessions.delete(session) })
      return ending
    }
    const onAbort = (): void => { void endSession() }
    ctx.signal.addEventListener('abort', onAbort)
    void (async () => {
      try {
        for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
          const { request } = next.value
          if (request.case === 'input') pty.write(Buffer.from(request.value))
          else if (request.case === 'resize') pty.resize(dimension(request.value.cols, 80), dimension(request.value.rows, 24))
          else if (request.case === 'signal') {
            if (!TERMINAL_SIGNALS.has(request.value)) continue
            const group = await foregroundGroup(pty.pid)
            if (group !== undefined) signalGroup(group, signalOf(request.value))
          } else if (request.case === 'status') respond({ case: 'status', value: create(TerminalStatusSchema, await status(pty.pid)) })
        }
      } catch {
        // A caller that breaks off sends no more.
      }
    })()
    void (async () => {
      const exit = await exited
      // What the program left running in its session ends with the call.
      await endSession()
      respond({ case: 'exit', value: exit })
      out.close()
    })()
    try {
      yield* out
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  /** End every terminal's session, as the helper ends. */
  async close(): Promise<void> {
    await Promise.all([...this.sessions].map(session => endAll(session)))
  }
}

/** Whether the terminal is idle, and its foreground process group. */
async function status(session: number): Promise<{ idle: boolean; foreground: number }> {
  const found = await members(session)
  const foreground = (await foregroundGroup(session)) ?? 0
  if (found.length === 0) return { idle: true, foreground }
  // After the program's name: its state, its parent, its group, its session, its terminal and that terminal's foreground group.
  const [state, , group] = await stat(session) ?? []
  return { idle: found.length === 1 && found[0] === session && state === 'S' && String(foreground) === group, foreground }
}

/** End every process of a session: SIGHUP and SIGTERM, then SIGKILL after its grace period; settles once none is left. */
async function endAll(session: Session): Promise<void> {
  await signalSession(session.id, 'SIGHUP')
  await signalSession(session.id, 'SIGTERM')
  const empty = await Promise.race([untilEmpty(session.id).then(() => true), delay(session.graceMs, false)])
  if (!empty) await signalSession(session.id, 'SIGKILL')
  await untilEmpty(session.id)
}

/** The fields of /proc/<pid>/stat after the program's name, which may hold spaces. */
async function stat(pid: number | string): Promise<string[] | undefined> {
  const line = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined)
  return line?.slice(line.lastIndexOf(')') + 2).split(' ')
}

/** The terminal's foreground process group, which the kernel keeps for the process it runs. */
async function foregroundGroup(pid: number): Promise<number | undefined> {
  const group = Number((await stat(pid))?.[5])
  return Number.isSafeInteger(group) && group > 0 ? group : undefined
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

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal)
  } catch {
    // The group is empty already.
  }
}

async function untilEmpty(session: number): Promise<void> {
  while ((await members(session)).length > 0) await delay(POLL_MS)
}

function signalName(signal: number): string {
  return Object.entries(constants.signals).find(([, number]) => number === signal)?.[0] ?? String(signal)
}

function dimension(value: number | undefined, otherwise: number): number {
  return value === undefined || value === 0 ? otherwise : value
}
