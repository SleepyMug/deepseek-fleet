/**
 * A terminal in a tau's box, such as the web UI's sidebar terminal of the
 * session: the box runs the shell on a pseudo-terminal there, one
 * `Box.Terminal` call for as long as it runs, and this handle relays its
 * input, output and size, asks the box its status, its foreground process
 * group, which it signals, and whether it is idle, and ends it, background
 * jobs included, by ending the call. It reports the terminal idle when the
 * box finds no process of it left, or its shell alone at its prompt, so
 * dsh's terminal controller reclaims one nobody has open after a while,
 * which ends its hold on the box (./box-subprocess.ts). Its environment, as
 * a process's in a box, leaves out dsh's own variables, which tell of the
 * host.
 * @module @sleepymug/dsh-tau/world/terminal
 */

import { PassThrough } from 'node:stream'
import { create, type MessageInitShape } from '@bufbuild/protobuf'
import type {
  SubprocessOutcome, SubprocessTerminalActivity, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { type ProgramSchema, type TerminalRequest, TerminalRequestSchema, type TerminalStatus } from '@sleepymug/fleet-protocol/box'
import type { RunBox } from '../tau/ports.ts'
import { Pushed } from '../util/stream.ts'

/** What dsh gives a process that tells of the host, and is false in a box, whose own the box keeps: where its programs are, and its home. */
const HOST_ONLY: ReadonlySet<string> = new Set(['PATH', 'HOME'])

/**
 * The environment a process in a box is given of what dsh gives it: all but
 * dsh's own variables, `DSH_*`, and the host's PATH and HOME, which tell of
 * the host, so that the box's own stand.
 */
export function boxEnv(env: Readonly<Record<string, string | null | undefined>> | undefined): Record<string, string | null> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !key.startsWith('DSH_') && !HOST_ONLY.has(key)).map(([key, value]) => [key, value ?? null]))
}

/** A program as a box runs it: its environment what dsh gives it, as {@link boxEnv} keeps it, added to the box's, a name given null removed. */
export function programOf(argv: readonly string[], cwd: string, env: Readonly<Record<string, string | null | undefined>> | undefined): MessageInitShape<typeof ProgramSchema> {
  const kept = Object.entries(boxEnv(env))
  return {
    argv: [...argv],
    cwd,
    env: Object.fromEntries(kept.filter((entry): entry is [string, string] => entry[1] !== null)),
    unsetEnv: kept.filter(([, value]) => value === null).map(([key]) => key),
  }
}

export class BoxTerminal implements SubprocessTerminalHandle {
  /** Changes with input, and with the activity reported, so an idle time is counted from either. */
  private revision = 0
  private activity: SubprocessTerminalActivity['state'] | undefined
  private ending: Promise<void> | undefined
  private gone = false
  /** What waits for each status asked, in order, as the box answers them. */
  private readonly asked: ((status: TerminalStatus | undefined) => void)[] = []

  private constructor(
    private readonly requests: Pushed<TerminalRequest>,
    /** Ends the call, which ends every process of the terminal's session. */
    private readonly cancel: AbortController,
    readonly pid: number,
    readonly output: PassThrough,
    readonly done: Promise<SubprocessOutcome>,
  ) {
    void done.finally(() => {
      this.gone = true
      for (const answer of this.asked.splice(0)) answer(undefined)
    }).catch(() => {})
  }

  /**
   * Start a terminal in a started box.
   * @returns the handle once the shell runs.
   */
  static async start(box: RunBox, spec: SubprocessTerminalSpawnSpec): Promise<BoxTerminal> {
    spec.signal?.throwIfAborted()
    const started = Promise.withResolvers<number>()
    const output = new PassThrough()
    const requests = new Pushed<TerminalRequest>()
    const cancel = new AbortController()
    requests.push(create(TerminalRequestSchema, {
      request: {
        case: 'start',
        value: { program: programOf(spec.argv, spec.cwd, spec.env), size: { cols: spec.cols, rows: spec.rows }, term: spec.terminalType ?? '', graceMs: spec.graceMs },
      },
    }))
    let terminal: BoxTerminal | undefined
    const done = (async (): Promise<SubprocessOutcome> => {
      try {
        for await (const { response } of box.api.terminal(requests, { signal: cancel.signal })) {
          switch (response.case) {
            case 'started': started.resolve(response.value.pid); break
            case 'output': output.write(Buffer.from(response.value)); break
            case 'status': terminal?.asked.shift()?.(response.value); break
            case 'exit': return { exitCode: response.value.code ?? null, signal: (response.value.signal === '' ? null : response.value.signal) as NodeJS.Signals | null }
            default: break
          }
        }
        throw new Error('fleet: the box said nothing of how the terminal\'s program ended')
      } finally {
        requests.end()
        // The output ends after what the shell wrote, whether it exited or the box was lost.
        output.end()
      }
    })()
    done.catch((error: unknown) => { started.reject(error) })
    terminal = new BoxTerminal(requests, cancel, await started.promise, output, done)
    return terminal
  }

  async write(data: string): Promise<void> {
    this.revision++
    this.requests.push(create(TerminalRequestSchema, { request: { case: 'input', value: Buffer.from(data) } }))
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.requests.push(create(TerminalRequestSchema, { request: { case: 'resize', value: { cols, rows } } }))
  }

  /** The box cannot tell whether the group waits for input, so it never says it does. */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    const status = await this.status()
    return status === undefined || status.foreground === 0 ? undefined : { processGroupId: status.foreground, inputWaiting: false }
  }

  /**
   * Idle once the terminal has ended, or when the box finds no process of
   * it left, or its shell alone at its prompt; busy otherwise; unknown
   * while it ends, or when the box cannot tell.
   */
  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    let state: SubprocessTerminalActivity['state']
    if (this.gone) state = 'idle'
    else if (this.ending !== undefined) state = 'unknown'
    else {
      const status = await this.status()
      state = status === undefined ? 'unknown' : status.idle ? 'idle' : 'busy'
    }
    if (state !== this.activity) {
      this.activity = state
      this.revision++
    }
    return { state, revision: this.revision }
  }

  /** Signal the terminal's foreground process group; its id, as the box last said it, or 0. */
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const status = await this.status()
    this.requests.push(create(TerminalRequestSchema, { request: { case: 'signal', value: signal } }))
    return status?.foreground ?? 0
  }

  /** End every process of the terminal's session, by ending its call, and wait until it ended; a box lost takes them along. */
  terminate(): Promise<void> {
    this.ending ??= (async () => {
      this.cancel.abort()
      await this.done.then(() => {}, () => {})
    })()
    return this.ending
  }

  /** The terminal's status, as the box answers it next; undefined once it has ended. */
  private status(): Promise<TerminalStatus | undefined> {
    if (this.gone) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      this.asked.push(resolve)
      this.requests.push(create(TerminalRequestSchema, { request: { case: 'status', value: {} } }))
    })
  }
}
