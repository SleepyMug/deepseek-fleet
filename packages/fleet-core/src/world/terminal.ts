/**
 * A terminal in a tau's box, such as the web UI's sidebar terminal of the
 * session: the box's helper runs the shell on a pseudo-terminal there
 * (fleet-box-runtime's helper/cmd/terminal.ts), and this handle relays its
 * input, output and size, and asks the helper for its foreground process
 * group, which it signals, and to end its whole session, background jobs
 * included. The helper does not watch the shell for prompts, so activity is
 * unknown.
 * @module fleet-core/world/terminal
 */

import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type {
  SubprocessOutcome, SubprocessTerminalActivity, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { RunBox } from '../tau/runs.ts'

export class BoxTerminal implements SubprocessTerminalHandle {
  private revision = 0
  private ending: Promise<void> | undefined

  private constructor(
    private readonly box: RunBox,
    /** The helper's id of the terminal. */
    private readonly id: string,
    readonly pid: number,
    readonly output: PassThrough,
    readonly done: Promise<SubprocessOutcome>,
  ) {}

  /**
   * Start a terminal in a started box.
   * @returns the handle once the shell runs.
   */
  static async start(box: RunBox, spec: SubprocessTerminalSpawnSpec): Promise<BoxTerminal> {
    spec.signal?.throwIfAborted()
    const env: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = value
    const started = Promise.withResolvers<number>()
    const output = new PassThrough()
    const id = randomUUID()
    const done = box.request('terminal', {
      terminal: id, argv: [...spec.argv], cwd: spec.cwd, env, cols: spec.cols, rows: spec.rows, term: spec.terminalType, graceMs: spec.graceMs,
    }, (event) => {
      if (event.kind === 'started') started.resolve(event.pid)
      else output.write(Buffer.from(event.data, 'base64'))
    }).then(({ code, signal }) => ({ exitCode: code, signal: signal as NodeJS.Signals | null }))
    // The output ends after what the shell wrote, whether it exited or the box was lost.
    void done.finally(() => { output.end() }).catch(() => {})
    done.catch((error: unknown) => { started.reject(error) })
    return new BoxTerminal(box, id, await started.promise, output, done)
  }

  async write(data: string): Promise<void> {
    this.revision++
    await this.box.request('terminal.write', { terminal: this.id, data })
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.box.request('terminal.resize', { terminal: this.id, cols, rows })
  }

  /** The helper cannot tell whether the group waits for input, so it never says it does. */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    const foreground = await this.box.request('terminal.foreground', { terminal: this.id })
    return foreground === null ? undefined : { processGroupId: foreground.processGroupId, inputWaiting: false }
  }

  inspectActivity(): Promise<SubprocessTerminalActivity> {
    return Promise.resolve({ state: 'unknown', revision: this.revision })
  }

  signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    return this.box.request('terminal.signal', { terminal: this.id, signal })
  }

  /** End every process of the terminal's session, and wait until none is left; a box lost takes them along. */
  terminate(): Promise<void> {
    this.ending ??= this.box.request('terminal.end', { terminal: this.id }).then(() => {}, () => {})
    return this.ending
  }
}
