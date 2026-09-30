/**
 * `ctx.subprocess` for the fleet execution world: every process runs in the
 * container of the session whose agent started it, in a process group of its
 * own that the helper terminates and watches, and so do a user's terminals
 * (./terminal.ts). A call is the session's when that session's turn makes it,
 * or when it comes through the session agent's own context, as dsh's
 * terminal controller calls; any other fails instead of running on the host.
 * Processes, terminals and executable lookups occupy their container
 * (./occupancy.ts), so one made outside a turn keeps it running too: a
 * process until it exits, a terminal until none of its processes is left,
 * and a lookup while it runs. What a process leaves running in its group
 * does not count, since bash runs in the foreground only; it ends when the
 * container stops.
 *
 * It serves what dsh's bash executor asks for: stdin ignored or given as
 * data, and stdout and stderr collected. Collected output keeps only its
 * in-memory tail, with no spill file, since the model reads files in its
 * container and a spill would sit on the host; bash then reports the full
 * output as unavailable. Raw pipes and the fd 7 control channel are refused;
 * their consumers are off in the fleet profile. Open terminals are session
 * activity, so archiving a session is refused while one is open, and ends
 * them when forced.
 *
 * Unloading this service terminates every process and terminal it started
 * that is still running and waits for them to end.
 * @module fleet-runtime/box/subprocess
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect, SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputMode, SubprocessSpawnSpec,
  SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import type {} from '@deepseek-ai/dsh-workspace'
import { EXECUTABLE_NOT_FOUND, type SpawnParams } from 'fleet-image/helper/protocol'
import { z } from 'zod'
import { HelperError, type HelperConnection } from './connection.ts'
import { ContainerTerminal } from './terminal.ts'
import type { FleetBox } from './world.ts'

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** A user's terminal runs in the session's container, which archiving the session removes. */
    terminal: true
  }
}

/** Node's timer ceiling, which bounds a grace period. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/**
 * Time past twice a terminated process's grace, its kill and then its output
 * drain, before the helper is checked for still answering.
 */
const TERMINATE_MARGIN_MS = 10_000

export class FleetBoxSubprocessRuntime extends SubprocessRuntime {
  static inject = ['fleetBox']

  /**
   * This service's own context; a caller that reaches this service makes
   * `this.ctx` its own, which is how a call names its session.
   */
  private readonly self: Context
  /** Processes whose group may still have members. */
  private readonly live = new Set<ContainerProcess>()
  /** Terminals with processes left, by root session. */
  private readonly terminals = new Map<SessionId, Set<ContainerTerminal>>()
  private disposed = false

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
    ctx.effect(() => async () => {
      this.disposed = true
      const live = [...this.live]
      for (const handle of live) handle.terminate()
      const terminals = [...this.terminals.values()].flatMap(open => [...open])
      // A process on a lost helper cannot be observed; its container stops with the world.
      await Promise.allSettled([...live.map(handle => handle.waitForExit()), ...terminals.map(terminal => terminal.terminate())])
    }, 'fleet-box processes')

    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const activity = await next()
      const open = [...this.terminals.get(sessionId) ?? []]
      if (open.length === 0) return activity
      return [{ kind: 'terminal', items: open.map(terminal => ({ id: terminal.id, label: terminal.label })) }, ...activity]
    })
    ctx.on('workspace/session-stop', ({ sessionId }) => {
      for (const terminal of this.terminals.get(sessionId) ?? []) {
        terminal.terminate().catch((error: unknown) => {
          ctx.logger.warn(`fleet-box: could not end terminal ${terminal.id} of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    })
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    const fleetBox = this.self.fleetBox
    const agent = fleetBox.agentOf('ctx.subprocess.resolveExecutable', this.ctx)
    const release = fleetBox.occupy(fleetBox.rootOf(agent), { kind: 'call', id: randomUUID() })
    try {
      const world = await fleetBox.forAgent(agent, signal)
      return await world.connection.request('executable', { command, env: env ?? null }, z.string(), signal)
    } catch (error) {
      if (error instanceof HelperError && error.code === EXECUTABLE_NOT_FOUND) {
        throw new SubprocessExecutableNotFoundError(error.message, { cause: error })
      }
      throw error
    } finally {
      release()
    }
  }

  /** The image's shell. */
  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.resolve({ platform: 'posix', defaultShell: '/bin/bash' })
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposed) throw new Error('fleet-box: ctx.subprocess is unloading')
    spec.signal?.throwIfAborted()
    if (spec.argv.length === 0) throw new Error('fleet-box: spawn needs a program')
    if (!spec.cwd.startsWith('/')) throw new Error(`fleet-box: spawn needs an absolute working folder, got ${spec.cwd}`)
    if (!(spec.graceMs > 0 && spec.graceMs <= MAX_TIMER_DELAY_MS)) throw new Error(`fleet-box: spawn needs a positive grace period, got ${spec.graceMs}`)
    if (spec.stdio.control !== undefined) throw new Error('fleet-box: the container world has no control channel')
    if (spec.stdio.stdin === 'pipe') throw new Error('fleet-box: the container world gives stdin only as data; \'pipe\' is not served')
    const stdout = collected(spec.stdio.stdout, 'stdout')
    const stderr = collected(spec.stdio.stderr, 'stderr')
    const fleetBox = this.self.fleetBox
    const agent = fleetBox.agentOf('ctx.subprocess.spawn', this.ctx)
    const release = fleetBox.occupy(fleetBox.rootOf(agent), { kind: 'process', id: randomUUID() })
    let handle: ContainerProcess
    try {
      handle = new ContainerProcess(fleetBox, agent, spec, stdout, stderr)
    } catch (error) {
      release()
      throw error
    }
    this.live.add(handle)
    // Bash runs in the foreground only, so what a command leaves behind in its group does not keep the container.
    void handle.done.then(release, release)
    void handle.gone.then(() => { this.live.delete(handle) })
    return handle
  }

  /**
   * Start a user's shell in the session's container. It occupies the
   * container from before it starts until none of its processes is left.
   */
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposed) throw new Error('fleet-box: ctx.subprocess is unloading')
    spec.signal?.throwIfAborted()
    if (spec.argv.length === 0 || spec.argv[0] === '') throw new Error('fleet-box: a terminal needs a program')
    if (!spec.cwd.startsWith('/')) throw new Error(`fleet-box: a terminal needs an absolute working folder, got ${spec.cwd}`)
    if (!(spec.graceMs > 0 && spec.graceMs <= MAX_TIMER_DELAY_MS)) throw new Error(`fleet-box: a terminal needs a positive grace period, got ${spec.graceMs}`)
    for (const key of Object.keys(spec.env ?? {})) {
      if (key === '' || key.includes('=')) throw new Error(`fleet-box: ${JSON.stringify(key)} is not an environment variable name`)
    }
    const fleetBox = this.self.fleetBox
    const agent = fleetBox.agentOf('ctx.subprocess.spawnTerminal', this.ctx)
    const root = fleetBox.rootOf(agent)
    const id = randomUUID()
    const release = fleetBox.occupy(root, { kind: 'terminal', id })
    let terminal: ContainerTerminal
    try {
      const world = await fleetBox.forAgent(agent, spec.signal)
      if (this.disposed) throw new Error('fleet-box: ctx.subprocess is unloading')
      spec.signal?.throwIfAborted()
      terminal = new ContainerTerminal(id, world, spec)
    } catch (error) {
      release()
      throw error
    }
    let open = this.terminals.get(root)
    if (open === undefined) {
      open = new Set()
      this.terminals.set(root, open)
    }
    const held = open
    held.add(terminal)
    void terminal.gone.then(() => {
      held.delete(terminal)
      if (held.size === 0 && this.terminals.get(root) === held) this.terminals.delete(root)
      release()
    })
    return terminal
  }
}


function collected(mode: SubprocessOutputMode, name: string): SubprocessCollect {
  if (typeof mode !== 'object') throw new Error(`fleet-box: the container world only collects ${name}; '${mode}' is not served`)
  return mode
}

/** One process in a session's container. */
class ContainerProcess implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly control = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  /** Settles once the process's group is empty, or can no longer be observed. */
  readonly gone: Promise<void>

  private readonly id = randomUUID()
  private readonly graceMs: number
  /** The connection the process started on, or undefined when it never started. */
  private readonly started: Promise<HelperConnection | undefined>
  private connection: HelperConnection | undefined
  private terminated = false

  constructor(fleetBox: FleetBox, agent: Agent, spec: SubprocessSpawnSpec, stdout: SubprocessCollect, stderr: SubprocessCollect) {
    const out = new OutputCollector(stdout.maxBytes, 'stdout', undefined)
    const err = new OutputCollector(stderr.maxBytes, 'stderr', undefined)
    this.collected = { stdout: out, stderr: err }
    this.graceMs = spec.graceMs
    const outcome = Promise.withResolvers<SubprocessOutcome>()
    this.done = outcome.promise
    void this.done.catch(() => {})
    this.gone = this.done.then(() => this.waitForExit(), () => true).then(() => {}, () => {})
    const signal = spec.signal
    if (signal !== undefined) {
      // An abort after the exit still stops what the process left in its group.
      const abort = (): void => { this.terminate() }
      signal.addEventListener('abort', abort, { once: true })
      void this.gone.then(() => { signal.removeEventListener('abort', abort) })
    }

    const env: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = value ?? null
    const stdin = spec.stdio.stdin
    const params: SpawnParams = {
      process: this.id, argv: [...spec.argv], cwd: spec.cwd, env,
      stdin: typeof stdin === 'object' ? stdin.data : null, graceMs: spec.graceMs,
    }
    this.started = (async () => {
      let unwatch = (): void => {}
      try {
        const { connection } = await fleetBox.forAgent(agent, spec.signal)
        if (this.terminated) throw spec.signal?.reason ?? new Error('fleet-box: the process was terminated before it started')
        unwatch = connection.watch(this.id, {
          output: (stream, data) => { (stream === 'stdout' ? out : err).push(data) },
          exit: (exitCode, signal) => { outcome.resolve({ exitCode, signal }) },
          lost: (error) => { outcome.reject(error) },
        })
        await connection.request('process.spawn', { ...params }, z.object({ pid: z.number().int() }))
        this.connection = connection
        if (this.terminated) this.sendTerminate(connection)
        return connection
      } catch (error) {
        unwatch()
        outcome.reject(error)
        return undefined
      }
    })()
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    // Before the process has started, its start sees the flag instead.
    if (this.connection !== undefined) this.sendTerminate(this.connection)
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    const connection = await this.started
    if (connection === undefined) return true
    try {
      return await connection.request('process.wait', { process: this.id }, z.boolean(), signal)
    } catch (error) {
      if (signal?.aborted === true) return false
      throw error
    }
  }

  private sendTerminate(connection: HelperConnection): void {
    // A lost helper takes its processes with it: the world's teardown stops the container.
    connection.request('process.terminate', { process: this.id }, z.null()).catch(() => {})
    // A helper that stops answering, as in a paused container, would never report the exit, so
    // once the exit is overdue, check the helper; a lost one settles `done` as lost.
    const timer = setInterval(() => { void connection.probe() }, Math.min(2 * this.graceMs + TERMINATE_MARGIN_MS, MAX_TIMER_DELAY_MS))
    timer.unref()
    const stop = (): void => { clearInterval(timer) }
    this.done.then(stop, stop)
  }
}

export default FleetBoxSubprocessRuntime
