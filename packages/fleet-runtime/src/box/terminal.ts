/**
 * A user's terminal in a session's container: a shell that `docker exec`
 * runs with a terminal of its own, driven from a pseudo-terminal on the host,
 * through which the Docker CLI relays input, output and window sizes. The
 * shell and everything it starts carry the terminal's marker
 * (fleet-image/helper/protocol), by which the helper finds them: `docker exec`
 * starts them outside the helper, and a Docker CLI that ends leaves them
 * running.
 *
 * `done` settles when the Docker CLI exits, with the shell's exit code;
 * `gone` once no process of the terminal is left in the container, which is
 * when it stops occupying the container. After an exit of its own, the
 * shell's leftovers, such as a `nohup` job, run on until they end or the
 * terminal is terminated; a shell whose Docker CLI ended without it can no
 * longer be reached, so it is ended at once. The world closing ends
 * everything in its container. Container process groups mean nothing on the
 * host, so the foreground group is not resolved and not signalled.
 * @module fleet-runtime/box/terminal
 */

import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { basename } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  SubprocessOutcome, SubprocessTerminalActivity, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { TERMINAL_MARKER } from 'fleet-image/helper/protocol'
import type { IPty } from 'node-pty'
import { z } from 'zod'
import { HelperError } from './connection.ts'
import type { SessionWorld } from './world.ts'

/**
 * Time past twice the grace, the hangup and then the kill, before the helper
 * is checked for still answering while a terminal ends.
 */
const TERMINATE_MARGIN_MS = 10_000
/** Node's timer ceiling. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/**
 * The key sequence that detaches the Docker CLI, which cannot be turned off.
 * The CLI holds back a key that starts it until the next one, so the default,
 * Ctrl-P then Ctrl-Q, would hold back readline's and editors' Ctrl-P; this one
 * starts with Ctrl-\, which is rarely typed alone, and is too odd to type by
 * chance. A detached CLI leaves a shell nobody can reach, which is ended.
 */
const DETACH_KEYS = 'ctrl-\\,ctrl-@,ctrl-\\,ctrl-@'

const stateSchema = z.object({ shell: z.boolean(), members: z.number().int().nonnegative(), prompt: z.boolean() })

const require = createRequire(import.meta.url)
let nodePty: typeof import('node-pty') | undefined
/** node-pty, loaded on first use, so a missing native build fails only terminals. */
function pty(): typeof import('node-pty') {
  nodePty ??= require('node-pty') as typeof import('node-pty')
  return nodePty
}

export class ContainerTerminal implements SubprocessTerminalHandle {
  /** The Docker CLI's pid on the host. */
  readonly pid: number
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>
  /** Settles once no process of the terminal is left in the container. */
  readonly gone: Promise<void>
  /** The shell's name, as the session's activity shows it. */
  readonly label: string

  private readonly terminal: IPty
  /** TERM-to-KILL grace, here hangup-to-kill, for the whole terminal. */
  private readonly graceMs: number
  private exited = false
  private isGone = false
  private paused = false
  private ending: Promise<void> | undefined
  /** Requests of inspections in flight, which terminate() waits for. */
  private readonly inspections = new Set<Promise<unknown>>()
  private activityKey = ''
  private activityRevision = 0

  /**
   * Start the shell in the world's container.
   * @param id - the terminal's id and marker value, as the helper checks them.
   * @throws when the Docker CLI does not start.
   */
  constructor(readonly id: string, private readonly world: SessionWorld, spec: SubprocessTerminalSpawnSpec) {
    this.label = basename(spec.argv[0] ?? '')
    const env = Object.entries(spec.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`])
    const args = [
      'exec', '--interactive', '--tty', '--detach-keys', DETACH_KEYS, '--workdir', spec.cwd, '--env', `TERM=${spec.terminalType}`, ...env,
      // Last, so no entry of the spec replaces it.
      '--env', `${TERMINAL_MARKER}=${id}`,
      world.container.name, ...spec.argv,
    ]
    this.terminal = pty().spawn(world.docker, args, { name: spec.terminalType, cols: spec.cols, rows: spec.rows })
    this.pid = this.terminal.pid
    // The helper counts in whole milliseconds.
    this.graceMs = Math.ceil(spec.graceMs)

    const outcome = Promise.withResolvers<SubprocessOutcome>()
    this.done = outcome.promise
    this.output.on('drain', () => {
      if (!this.paused || this.exited) return
      this.paused = false
      this.terminal.resume()
    })
    this.terminal.onData((data) => {
      if (this.output.writableEnded) return
      if (!this.output.write(Buffer.from(data, 'utf8')) && this.ending === undefined && !this.paused) {
        this.paused = true
        this.terminal.pause()
      }
    })
    this.terminal.onExit(({ exitCode, signal }) => {
      if (this.exited) return
      this.exited = true
      this.output.end()
      outcome.resolve({ exitCode: signal === undefined || signal === 0 ? exitCode : null, signal: signalName(signal) })
    })

    const emptied = this.done.then(async () => {
      const connection = world.connection
      const state = await connection.request('terminal.state', { terminal: id }, stateSchema)
      // Its shell outlived the Docker CLI, and nobody can reach it now.
      if (state.shell) await connection.request('terminal.end', { terminal: id, graceMs: this.graceMs }, z.null())
      await connection.request('terminal.wait', { terminal: id }, z.null())
    })
    // A helper that cannot answer is lost, and its world's teardown stops the container, ending the
    // terminal. One that answers with an error cannot tell, and the terminal would otherwise hold
    // the container for good, so the terminal counts as gone; anything left ends with the container.
    this.gone = Promise.race([emptied.catch((error: unknown) => error instanceof HelperError ? undefined : world.stopped), world.stopped])
    void this.gone.then(() => { this.isGone = true })
  }

  write(data: string): Promise<void> {
    if (this.exited) return Promise.reject(new Error('terminal process has exited'))
    this.activityRevision++
    this.terminal.write(data)
    return Promise.resolve()
  }

  resize(cols: number, rows: number): Promise<void> {
    if (this.exited) return Promise.reject(new Error('terminal process has exited'))
    this.terminal.resize(cols, rows)
    return Promise.resolve()
  }

  /** Container process groups are not host process groups, so none is resolved. */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return Promise.resolve(undefined)
  }

  /**
   * Idle when no process of the terminal is left, or when its shell waits at
   * its prompt with nothing else running; busy otherwise.
   */
  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    let state: SubprocessTerminalActivity['state']
    if (this.isGone) state = 'idle'
    else if (this.ending !== undefined) state = 'unknown'
    else {
      try {
        const facts = await this.track(this.world.connection.request('terminal.state', { terminal: this.id }, stateSchema))
        state = facts.members === 0 || facts.prompt ? 'idle' : 'busy'
      } catch {
        state = 'unknown'
      }
    }
    if (state !== this.activityKey) {
      this.activityKey = state
      this.activityRevision++
    }
    return { state, revision: this.activityRevision }
  }

  signalForeground(): Promise<number> {
    return Promise.reject(new Error('fleet-box: the container world does not signal a terminal\'s foreground'))
  }

  /**
   * Hang up every process of the terminal, kill what remains after the
   * grace, and settle once none is left; idempotent.
   */
  terminate(): Promise<void> {
    this.ending ??= this.end()
    return this.ending
  }

  private async end(): Promise<void> {
    // The Docker CLI drains what is left while the terminal ends.
    if (this.paused) {
      this.paused = false
      this.terminal.resume()
    }
    const connection = this.world.connection
    // A helper that stops answering, as in a paused container, would never end the terminal, so
    // once that is overdue, check the helper; a lost one closes the world, which settles `gone`.
    const probe = setInterval(() => { void connection.probe() }, Math.min(2 * this.graceMs + TERMINATE_MARGIN_MS, MAX_TIMER_DELAY_MS))
    probe.unref()
    try {
      await connection.request('terminal.end', { terminal: this.id, graceMs: this.graceMs }, z.null()).catch(() => {})
      // With its shell gone the Docker CLI exits; one that lingers is killed.
      if (!this.exited && !(await settlesWithin(this.done, this.graceMs))) {
        try {
          this.terminal.kill('SIGKILL')
        } catch {
          // It has exited.
        }
      }
      await this.gone
      await Promise.allSettled(this.inspections)
    } finally {
      clearInterval(probe)
    }
  }

  private track<T>(request: Promise<T>): Promise<T> {
    this.inspections.add(request)
    void request.finally(() => { this.inspections.delete(request) }).catch(() => {})
    return request
  }
}

async function settlesWithin(operation: Promise<unknown>, ms: number): Promise<boolean> {
  const controller = new AbortController()
  try {
    return await Promise.race([operation.then(() => true), delay(ms, false, { signal: controller.signal })])
  } finally {
    controller.abort()
  }
}

function signalName(number: number | undefined): NodeJS.Signals | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) if (value === number) return name as NodeJS.Signals
  return null
}
