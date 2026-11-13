/**
 * `ctx.subprocess` of the boxes of taus' sessions, and of nothing else: the
 * `tau` agent preset's own, for its bash, and what fleet-subprocess
 * (./subprocess.ts), the host's, builds on.
 *
 * A process is a tau's session's when that session's turn starts it, or it
 * comes through that session's agent's context (./caller.ts). Its box runs
 * it in a process group of its own, `Box.Spawn`, one call for as long as it
 * runs, in the folder dsh names, and sends what it writes, which is
 * collected here into dsh's in-memory tails, as dsh's bash asks: stdin
 * ignored or given as data, stdout and stderr collected. Collected output
 * has no spill file, since a spill would sit on the host, where the
 * session's file tools do not look. Terminating it, or aborting its signal,
 * ends its group: SIGTERM, as a request, so that its exit is still told;
 * then, after its grace period, the call is cancelled, which has the box
 * end the group, SIGKILL after SIGTERM. Its
 * environment is what dsh gives it, but dsh's own variables, `DSH_*`, which
 * tell of the host, such as its dsh home and its web UI's URL, and are
 * false in a box.
 *
 * A terminal a tau's session opens, such as the web UI's sidebar terminal,
 * which dsh's terminal controller reaches through the session's agent, runs
 * in its box too (./terminal.ts), with the image's bash.
 *
 * Any other process is refused, so a session that is not a tau's, as one a
 * person gives the `tau` preset, runs nothing through it; fleet-subprocess
 * runs it on the host instead.
 *
 * Not served for a box: raw pipes and the control channel.
 * @module @sleepymug/dsh-tau/world/box-subprocess
 */

import { randomUUID } from 'node:crypto'
import { create } from '@bufbuild/protobuf'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect, SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputMode, SubprocessSpawnSpec,
  SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { type SpawnRequest, SpawnRequestSchema } from '@sleepymug/fleet-protocol/box'
import type { Held, Occupant, TauBoxes } from '../tau/ports.ts'
import type {} from '../services.ts'
import { Pushed } from '../util/stream.ts'
import { callerSession } from './caller.ts'
import { BoxTerminal, programOf } from './terminal.ts'

export class BoxSubprocessRuntime extends SubprocessRuntime {
  static inject = ['fleetTauRuns', 'agents']

  /** The service's own context; `this.ctx` is the context each call reaches it through. */
  protected readonly self: Context
  /** Which sessions are a tau's, and their boxes. */
  protected readonly runs: TauBoxes
  /** A box's processes still running, which this service ends as it unloads. */
  private readonly live = new Set<BoxProcess>()
  /** A box's terminals still open, which this service ends as it unloads. */
  private readonly terminals = new Set<BoxTerminal>()

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
    this.runs = ctx.fleetTauRuns
    ctx.effect(() => async () => {
      const live = [...this.live]
      for (const process of live) process.terminate()
      await Promise.allSettled([...live.map(process => process.done), ...[...this.terminals].map(terminal => terminal.terminate())])
    }, 'fleet box processes')
  }

  /** What runs a process that is no box's: nothing here; fleet-subprocess gives the host's. */
  protected host(): Promise<SubprocessRuntime> {
    return Promise.reject(refused())
  }

  /** The same, for a call that cannot wait for it. */
  protected hostNow(): SubprocessRuntime {
    throw refused()
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    const session = this.boxSession()
    if (session === undefined) return (await this.host()).resolveExecutable(command, env, signal)
    const { box, release } = await holdBox(this.runs, session, { kind: 'call', id: randomUUID() })
    try {
      const { path } = await box.api.which({ command }, signal === undefined ? {} : { signal })
      if (path === '') throw new SubprocessExecutableNotFoundError(`${command} is not on the box's PATH`)
      return path
    } finally {
      release()
    }
  }

  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    if (this.boxSession() !== undefined) return { platform: 'posix', defaultShell: '/bin/bash' }
    return (await this.host()).terminalEnvironment(signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const session = this.boxSession()
    if (session === undefined) return this.hostNow().spawn(spec)
    spec.signal?.throwIfAborted()
    if (spec.argv.length === 0) throw new Error('fleet: spawn needs a program')
    if (!spec.cwd.startsWith('/')) throw new Error(`fleet: spawn needs an absolute working folder, got ${spec.cwd}`)
    if (spec.stdio.control !== undefined) throw new Error('fleet: a box has no control channel')
    if (spec.stdio.stdin === 'pipe') throw new Error('fleet: a box takes stdin only as data; \'pipe\' is not served')
    // dsh runs the session's work in its project, which is /tau/workspace in the box.
    const inBox = { ...spec, cwd: this.runs.boxPath(session, spec.cwd) }
    const process = new BoxProcess(this.runs, session, inBox, collected(spec.stdio.stdout, 'stdout'), collected(spec.stdio.stderr, 'stderr'))
    this.live.add(process)
    void process.done.finally(() => { this.live.delete(process) }).catch(() => {})
    return process
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const session = this.boxSession()
    if (session === undefined) return (await this.host()).spawnTerminal(spec)
    // The user's terminal occupies the box until it ends.
    const { box, release } = await holdBox(this.runs, session, { kind: 'terminal', id: randomUUID() })
    let terminal: BoxTerminal
    try {
      terminal = await BoxTerminal.start(box, { ...spec, cwd: this.runs.boxPath(session, spec.cwd) })
    } catch (error) {
      release()
      throw error
    }
    this.terminals.add(terminal)
    void terminal.done.finally(() => {
      this.terminals.delete(terminal)
      release()
    }).catch(() => {})
    return terminal
  }

  /** The session the call is for, if it is a tau's, whose box serves it. */
  private boxSession(): string | undefined {
    const session = callerSession(this.self, this.ctx)
    return session !== undefined && this.runs.isTau(session) ? session : undefined
  }
}

function refused(): Error {
  return new Error('fleet: this subprocess runtime runs only the processes of a tau\'s session, in its box')
}

function collected(mode: SubprocessOutputMode, name: string): SubprocessCollect {
  if (typeof mode !== 'object') throw new Error(`fleet: a box only collects ${name}; '${mode}' is not served`)
  return mode
}

/** A session's started box, which `occupant` occupies until the release. */
async function holdBox(runs: TauBoxes, session: string, occupant: Occupant): Promise<Held> {
  const held = await runs.hold(session, occupant)
  if (held === undefined) throw new Error(`fleet: ${session} is not a tau's session, so it has no box`)
  return held
}

/** One process in a tau's box: one `Box.Spawn` call, for as long as it runs. */
class BoxProcess implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly control = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly requests = new Pushed<SpawnRequest>()
  /** Cancels the call, which has the box end the process's group: SIGTERM, then SIGKILL after its grace period. */
  private readonly cancel = new AbortController()
  private terminated = false

  constructor(runs: TauBoxes, session: string, private readonly spec: SubprocessSpawnSpec, stdout: SubprocessCollect, stderr: SubprocessCollect) {
    const out = new OutputCollector(stdout.maxBytes, 'stdout', undefined)
    const err = new OutputCollector(stderr.maxBytes, 'stderr', undefined)
    this.collected = { stdout: out, stderr: err }
    const stdin = spec.stdio.stdin
    this.requests.push(create(SpawnRequestSchema, {
      request: { case: 'start', value: { program: programOf(spec.argv, spec.cwd, spec.env), stdin: typeof stdin === 'object', graceMs: spec.graceMs } },
    }))
    if (typeof stdin === 'object') {
      this.requests.push(create(SpawnRequestSchema, { request: { case: 'stdin', value: Buffer.from(stdin.data) } }))
      this.requests.push(create(SpawnRequestSchema, { request: { case: 'closeStdin', value: true } }))
    }
    // The process occupies its box until it exits.
    const held = holdBox(runs, session, { kind: 'process', id: randomUUID() })
    this.done = held.then(async ({ box, release }) => {
      try {
        let outcome: SubprocessOutcome | undefined
        for await (const { response } of box.api.spawn(this.requests, { signal: this.cancel.signal })) {
          if (response.case === 'stdout') out.push(Buffer.from(response.value))
          else if (response.case === 'stderr') err.push(Buffer.from(response.value))
          else if (response.case === 'exit') {
            outcome = { exitCode: response.value.code ?? null, signal: (response.value.signal === '' ? null : response.value.signal) as NodeJS.Signals | null }
          }
        }
        if (outcome === undefined) throw new Error('fleet: the box said nothing of how the process ended')
        return outcome
      } finally {
        this.requests.end()
        release()
      }
    })
    void this.done.catch(() => {})
    const signal = spec.signal
    if (signal !== undefined) {
      const abort = (): void => { this.terminate() }
      signal.addEventListener('abort', abort, { once: true })
      void this.done.finally(() => { signal.removeEventListener('abort', abort) }).catch(() => {})
    }
  }

  /** End the process's group: SIGTERM, and, once its grace period is over, the call cancelled, which has the box SIGKILL what is left. */
  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.requests.push(create(SpawnRequestSchema, { request: { case: 'signal', value: 'SIGTERM' } }))
    const timer = setTimeout(() => { this.cancel.abort() }, this.spec.graceMs)
    void this.done.finally(() => { clearTimeout(timer) }).catch(() => {})
  }

  /** The box answers a process once its group is done with its output, so its end is its exit. */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    const ended = this.done.then(() => true, () => true)
    if (signal === undefined) return ended
    if (signal.aborted) return false
    return Promise.race([ended, new Promise<boolean>((resolve) => { signal.addEventListener('abort', () => { resolve(false) }, { once: true }) })])
  }
}

export default BoxSubprocessRuntime
