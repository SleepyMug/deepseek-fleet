/**
 * `ctx.subprocess` for the fleet profile: a tau's session runs its processes
 * in its box, and everything else runs them on the host, through dsh's own
 * local subprocess runtime, which this service mounts where only it sees it.
 *
 * A process is a tau's session's when that session's turn starts it, or it
 * comes through that session's agent's context (./caller.ts). Its box's
 * helper runs it in a process group of its own (fleet-image's
 * helper/cmd/spawn.ts), in the folder dsh names, and sends what it writes,
 * which is collected here into dsh's in-memory tails, as dsh's bash asks:
 * stdin ignored or given as data, stdout and stderr collected. Collected
 * output has no spill file, since a spill would sit on the host, where the
 * session's file tools do not look. Terminating it, or aborting its signal,
 * ends its group: SIGTERM, then SIGKILL after its grace period.
 *
 * Not served for a box: raw pipes, the control channel, and terminals, so
 * the sidebar's terminal of a tau's session fails rather than open on the
 * host.
 * @module fleet-core/world/subprocess
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect, SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputMode, SubprocessSpawnSpec,
  SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { EXECUTABLE_NOT_FOUND } from 'fleet-image/helper/protocol'
import { HelperError } from '../box/helper.ts'
import type { TauRuns } from '../tau/runs.ts'
import type {} from '../tau/runs-plugin.ts'
import { callerSession } from './caller.ts'

export class FleetSubprocessRuntime extends SubprocessRuntime {
  static inject = ['fleetTauRuns', 'agents']

  private readonly self: Context
  /** dsh's local subprocess runtime, for every process that is not a box's. */
  private local: SubprocessRuntime | undefined
  private readonly localReady: Promise<SubprocessRuntime>
  /** A box's processes still running, which this service ends as it unloads. */
  private readonly live = new Set<BoxProcess>()

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
    // Mounted where only this service sees it, so that it does not stand in for this one.
    const isolated = ctx.isolate('subprocess')
    this.localReady = (async () => {
      await isolated.plugin(LocalSubprocessRuntime)
      this.local = isolated.get('subprocess') as SubprocessRuntime
      return this.local
    })()
    ctx.effect(() => async () => {
      const live = [...this.live]
      for (const process of live) process.terminate()
      await Promise.allSettled(live.map(process => process.done))
    }, 'fleet box processes')
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    const session = this.boxSession()
    if (session === undefined) return (await this.localReady).resolveExecutable(command, env, signal)
    const box = await boxOf(this.self.fleetTauRuns, session)
    try {
      return await box.request('which', { command, env: env === undefined ? null : { ...env } })
    } catch (error) {
      if (error instanceof HelperError && error.code === EXECUTABLE_NOT_FOUND) throw new SubprocessExecutableNotFoundError(error.message, { cause: error })
      throw error
    }
  }

  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return (await this.localReady).terminalEnvironment(signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const session = this.boxSession()
    if (session === undefined) return this.localNow().spawn(spec)
    spec.signal?.throwIfAborted()
    if (spec.argv.length === 0) throw new Error('fleet: spawn needs a program')
    if (!spec.cwd.startsWith('/')) throw new Error(`fleet: spawn needs an absolute working folder, got ${spec.cwd}`)
    if (spec.stdio.control !== undefined) throw new Error('fleet: a box has no control channel')
    if (spec.stdio.stdin === 'pipe') throw new Error('fleet: a box takes stdin only as data; \'pipe\' is not served')
    const process = new BoxProcess(this.self.fleetTauRuns, session, spec, collected(spec.stdio.stdout, 'stdout'), collected(spec.stdio.stderr, 'stderr'))
    this.live.add(process)
    void process.done.finally(() => { this.live.delete(process) }).catch(() => {})
    return process
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const session = this.boxSession()
    if (session !== undefined) throw new Error(`fleet: ${session} is a tau's session, whose box has no terminals yet`)
    return (await this.localReady).spawnTerminal(spec)
  }

  /** The session the call is for, if it is a tau's, whose box serves it. */
  private boxSession(): string | undefined {
    const session = callerSession(this.self, this.ctx)
    return session !== undefined && this.self.fleetTauRuns.isTau(session) ? session : undefined
  }

  /** The local runtime, for a call that cannot wait for it; every call after startup finds it there. */
  private localNow(): SubprocessRuntime {
    if (this.local === undefined) throw new Error('fleet: ctx.subprocess is starting')
    return this.local
  }
}

function collected(mode: SubprocessOutputMode, name: string): SubprocessCollect {
  if (typeof mode !== 'object') throw new Error(`fleet: a box only collects ${name}; '${mode}' is not served`)
  return mode
}

async function boxOf(runs: TauRuns, session: string): Promise<NonNullable<Awaited<ReturnType<TauRuns['boxFor']>>>> {
  const box = await runs.boxFor(session)
  if (box === undefined) throw new Error(`fleet: ${session} is not a tau's session, so it has no box`)
  return box
}

/** One process in a tau's box. */
class BoxProcess implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly control = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly id = randomUUID()
  /** The box the process started in, once it has. */
  private readonly started: Promise<Awaited<ReturnType<typeof boxOf>> | undefined>
  private terminated = false

  constructor(runs: TauRuns, session: string, spec: SubprocessSpawnSpec, stdout: SubprocessCollect, stderr: SubprocessCollect) {
    const out = new OutputCollector(stdout.maxBytes, 'stdout', undefined)
    const err = new OutputCollector(stderr.maxBytes, 'stderr', undefined)
    this.collected = { stdout: out, stderr: err }
    const env: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = value ?? null
    const stdin = spec.stdio.stdin
    const box = boxOf(runs, session)
    this.started = box.then(found => found, () => undefined)
    this.done = box.then(found => found.request('spawn', {
      process: this.id, argv: [...spec.argv], cwd: spec.cwd, env,
      stdin: typeof stdin === 'object' ? stdin.data : null, graceMs: spec.graceMs,
    }, (event) => { (event.stream === 'stdout' ? out : err).push(Buffer.from(event.data, 'base64')) }))
      .then(({ code, signal }) => ({ exitCode: code, signal: signal as NodeJS.Signals | null }))
    void this.done.catch(() => {})
    const signal = spec.signal
    if (signal !== undefined) {
      const abort = (): void => { this.terminate() }
      signal.addEventListener('abort', abort, { once: true })
      void this.done.finally(() => { signal.removeEventListener('abort', abort) }).catch(() => {})
    }
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    // Sent once the process has a box; a box lost with it takes the process along.
    void this.started.then(box => box?.request('kill', { process: this.id })).catch(() => {})
  }

  /** The helper answers a process once its group is done with its output, so its end is its exit. */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    const ended = this.done.then(() => true, () => true)
    if (signal === undefined) return ended
    if (signal.aborted) return false
    return Promise.race([ended, new Promise<boolean>((resolve) => { signal.addEventListener('abort', () => { resolve(false) }, { once: true }) })])
  }
}

export default FleetSubprocessRuntime
