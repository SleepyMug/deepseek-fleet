/**
 * The programs the helper runs, as the container's root, without a shell:
 * `exec`, to its end, and `spawn`, streamed both ways. A spawned program
 * starts a session of its own, so its process group holds it and whatever
 * it starts, but what starts a session of its own; ending it ends that
 * group, SIGTERM and then SIGKILL after its grace period, and so does the
 * helper's own end. Whatever escapes it ends when the box stops.
 * @module @sleepymug/fleet-box/helper/box/processes
 */

import { spawn as start, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { constants as system } from 'node:os'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect'
import {
  ExecResponseSchema, type ExecRequest, type Exit, ExitSchema, type Program, type SpawnRequest, type SpawnResponse, SpawnResponseSchema, StartedSchema, type WhichRequest,
} from '@sleepymug/fleet-protocol/box'
import type { BoxLayout } from '@sleepymug/fleet-protocol/layout'
import { Channel } from '../channel.ts'
import { invalid, systemError } from '../errors.ts'
import { programEnvironment } from './env.ts'

/** How long a program's output may stay open after it exits, and SIGTERM has before SIGKILL, unless the call says. */
const DEFAULT_GRACE_MS = 2000
/** How often a process group is checked for members left. */
const POLL_MS = 100

/** A group being run, as the helper's end ends it. */
interface Group {
  readonly id: number
  readonly graceMs: number
  /** Settles once its program has exited and the group is empty. */
  readonly gone: Promise<void>
}

/** The programs of one helper, which end with it. */
export class Processes {
  private readonly groups = new Set<Group>()

  /** @param env - the box's environment, which each program starts from. */
  constructor(private readonly env: Readonly<Record<string, string>>, private readonly layout: BoxLayout) {}

  /** Run a program to its end, and answer how it ended and all it wrote. */
  async exec(req: ExecRequest): Promise<MessageInitShape<typeof ExecResponseSchema>> {
    const child = await this.launch(req.program, { stdin: req.stdin !== undefined, group: false })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    child.stdin?.on('error', () => {})
    child.stdin?.end(req.stdin)
    const exit = await new Promise<Exit>((resolve) => { child.once('close', (code, signal) => { resolve(exitOf(code, signal)) }) })
    return { exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
  }

  /**
   * Run a program in a process group of its own, as `Box.Spawn` has it:
   * the first request starts it, those after it write its input, close it
   * or signal its group; what it writes is answered as it comes, and how it
   * ended last.
   */
  async *spawn(requests: AsyncIterable<SpawnRequest>, ctx: HandlerContext): AsyncGenerator<SpawnResponse> {
    const iterator = requests[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done === true || first.value.request.case !== 'start') throw invalid('a spawn starts with what to run')
    const { program, stdin, graceMs } = first.value.request.value
    const grace = graceMs === 0 ? DEFAULT_GRACE_MS : graceMs
    const child = await this.launch(program, { stdin, group: true })
    const id = child.pid as number
    const exited = new Promise<Exit>((resolve) => { child.once('exit', (code, signal) => { resolve(exitOf(code, signal)) }) })
    const group: Group = { id, graceMs: grace, gone: exited.then(() => untilEmpty(id)) }
    this.groups.add(group)
    void group.gone.finally(() => { this.groups.delete(group) })
    const out = new Channel<SpawnResponse>()
    out.push(create(SpawnResponseSchema, { response: { case: 'started', value: create(StartedSchema, { pid: id }) } }))
    const outputs = [forward(child.stdout as Readable, 'stdout', out), forward(child.stderr as Readable, 'stderr', out)]
    // The caller gone, or the call cancelled, its group ends.
    const onAbort = (): void => { void end(group) }
    ctx.signal.addEventListener('abort', onAbort)
    // What the caller sends after the start, until it is done sending.
    void (async () => {
      try {
        for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
          const { request } = next.value
          if (request.case === 'stdin') child.stdin?.write(request.value)
          else if (request.case === 'closeStdin') child.stdin?.end()
          else if (request.case === 'signal') signalGroup(id, signalOf(request.value))
          else if (request.case === 'start') throw invalid('a spawn starts once')
        }
      } catch {
        // A caller that breaks off sends no more.
      }
    })()
    child.stdin?.on('error', () => {})
    void (async () => {
      const exit = await exited
      // Its output, once it ends, or its grace period after the exit, when something it started keeps it open.
      const drained = await Promise.race([Promise.all(outputs).then(() => true), delay(grace, false)])
      if (!drained) {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      out.push(create(SpawnResponseSchema, { response: { case: 'exit', value: exit } }))
      out.close()
    })()
    try {
      yield* out
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  /** Where a program is: an absolute path that is an executable file, or a bare name on the box's PATH; empty when it is not there. */
  async which({ command }: WhichRequest): Promise<{ path: string }> {
    if (command === '') throw invalid('which takes a command')
    if (command.includes('/')) {
      if (!isAbsolute(command)) throw invalid(`${command} is a relative path; give an absolute path or a bare name`)
      return { path: await isExecutable(command) ? command : '' }
    }
    const path = programEnvironment(this.env, {}, [], this.layout).PATH ?? ''
    for (const folder of path.split(':')) {
      if (!isAbsolute(folder)) continue
      const candidate = join(folder, command)
      if (await isExecutable(candidate)) return { path: candidate }
    }
    return { path: '' }
  }

  /** End every group, as the helper ends: SIGTERM, then SIGKILL after the longest grace period. */
  async close(): Promise<void> {
    await Promise.all([...this.groups].map(group => end(group)))
  }

  /** Start `program`; one that cannot start, or a working folder that is not there, fails. */
  private async launch(program: Program | undefined, options: { stdin: boolean; group: boolean }): Promise<ChildProcess> {
    const [file, ...args] = program?.argv ?? []
    if (file === undefined || file === '') throw invalid('a program is its argv, the program first')
    const cwd = program?.cwd === undefined || program.cwd === '' ? '/' : program.cwd
    if (!isAbsolute(cwd)) throw invalid(`the working folder ${cwd} is not an absolute path`)
    if (!(await stat(cwd).then(info => info.isDirectory(), () => false))) {
      throw new ConnectError(`the working folder ${cwd} is not a folder in the box`, Code.FailedPrecondition)
    }
    const env = programEnvironment(this.env, program?.env ?? {}, program?.unsetEnv ?? [], this.layout)
    const child = start(file, args, { cwd, env, detached: options.group, stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } catch (error) {
      throw systemError(error, `${file} cannot run`)
    }
    // Later errors, such as signalling a process that has exited, change nothing.
    child.on('error', () => {})
    return child
  }
}

/** Answer what `stream` writes, pausing it while the caller is behind; settles once it closes. */
function forward(stream: Readable, name: 'stdout' | 'stderr', out: Channel<SpawnResponse>): Promise<void> {
  stream.on('data', (chunk: Buffer) => {
    if (!out.push(create(SpawnResponseSchema, { response: { case: name, value: chunk } }))) {
      stream.pause()
      out.drained(() => { stream.resume() })
    }
  })
  return new Promise((resolve) => { stream.once('close', () => { resolve() }) })
}

/** End a group: SIGTERM, then SIGKILL after its grace period; settles once it is empty. */
async function end(group: Group): Promise<void> {
  signalGroup(group.id, 'SIGTERM')
  if (!(await Promise.race([group.gone.then(() => true), delay(group.graceMs, false)]))) signalGroup(group.id, 'SIGKILL')
  await group.gone
}

/** How a program ended, as Node says it. */
export function exitOf(code: number | null, signal: NodeJS.Signals | string | null): Exit {
  return create(ExitSchema, signal === null ? { code: code ?? 0 } : { signal })
}

/** A signal by its name, such as SIGINT; any other name is refused. */
export function signalOf(name: string): NodeJS.Signals {
  if (!Object.hasOwn(system.signals, name)) throw invalid(`${name} is no signal`)
  return name as NodeJS.Signals
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

