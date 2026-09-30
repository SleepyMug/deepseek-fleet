/**
 * The processes one helper runs. Each starts in a session of its own, so its
 * process group holds it and whatever it starts, except processes that start
 * a session of their own; termination and quiescence both address that group.
 * Whatever escapes it dies when the container stops.
 * @module fleet-image/helper/processes
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { OUTPUT_CHUNK_BYTES, type HelperMessage, type SpawnParams } from './protocol.ts'

/** How often a process group is checked for remaining members. */
const POLL_MS = 100
/** How long {@link Processes.close} waits to report the exits its SIGKILL causes. */
const REPORT_AFTER_KILL_MS = 500

/** The helper's line to the host. */
export interface Channel {
  /** Queue one message; false when the host has fallen behind. */
  send(message: HelperMessage): boolean
  /** Run a listener each time the host catches up. */
  onDrain(listener: () => void): void
}

interface Running {
  group: number
  graceMs: number
  terminating: boolean
  /** Settles once the process's exit is sent. */
  reported: Promise<void>
  /** Settles once the process has exited and its group is empty. */
  gone: Promise<void>
}

/** One output stream being forwarded, and when it ends. */
interface Forwarded {
  stream: Readable
  closed: Promise<void>
}

export class Processes {
  private readonly running = new Map<string, Running>()
  /** Output streams being forwarded; paused together while the host is behind. */
  private readonly outputs = new Set<Readable>()
  private paused = false

  constructor(private readonly channel: Channel) {
    channel.onDrain(() => {
      this.paused = false
      for (const stream of this.outputs) stream.resume()
    })
  }

  /**
   * Start a process in its own session.
   * @returns its pid, once it runs.
   * @throws when it could not start, such as a missing program or folder.
   */
  async spawn(params: SpawnParams): Promise<{ pid: number }> {
    if (this.running.has(params.process)) throw new Error(`process ${params.process} already exists`)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    for (const [key, value] of Object.entries(params.env)) {
      if (value === null) Reflect.deleteProperty(env, key)
      else env[key] = value
    }
    const [program = '', ...args] = params.argv
    const child = spawn(program, args, {
      cwd: params.cwd, env, detached: true, stdio: [params.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } catch (error) {
      // Node names the program when the folder is what is missing.
      const folder = await stat(params.cwd).then(info => info.isDirectory(), () => false)
      throw folder ? error : new Error(`the working folder ${params.cwd} does not exist in the container`)
    }
    // Later errors, such as signalling a process that already exited, change nothing.
    child.on('error', () => {})
    const group = child.pid as number
    const exited = Promise.withResolvers<void>()
    const record: Running = {
      group, graceMs: params.graceMs, terminating: false, reported: exited.promise,
      gone: exited.promise.then(() => this.untilEmpty(group)).finally(() => { this.running.delete(params.process) }),
    }
    this.running.set(params.process, record)
    if (params.stdin !== null) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(params.stdin)
    }
    const outputs = [
      this.forward(params.process, 'stdout', child.stdout as Readable),
      this.forward(params.process, 'stderr', child.stderr as Readable),
    ]
    child.once('exit', (exitCode, signal) => {
      void this.finish(params.process, record, outputs, exitCode, signal).finally(() => { exited.resolve() })
    })
    return { pid: group }
  }

  /** Start terminating a process group: SIGTERM, then SIGKILL after its grace; nothing once it is gone. */
  terminate(id: string): void {
    const record = this.running.get(id)
    if (record === undefined || record.terminating) return
    record.terminating = true
    signalGroup(record.group, 'SIGTERM')
    void Promise.race([record.gone.then(() => true), delay(record.graceMs, false)]).then((gone) => {
      if (!gone) signalGroup(record.group, 'SIGKILL')
    })
  }

  /**
   * Wait until a process has exited and its group is empty.
   * @returns true then, or false if the signal aborts first; an unknown process is gone.
   */
  async wait(id: string, signal: AbortSignal): Promise<boolean> {
    const record = this.running.get(id)
    if (record === undefined) return true
    const aborted = new Promise<boolean>((resolve) => {
      if (signal.aborted) resolve(false)
      signal.addEventListener('abort', () => { resolve(false) }, { once: true })
    })
    return Promise.race([record.gone.then(() => true), aborted])
  }

  /**
   * Stop every process group: SIGTERM, then SIGKILL after the longest grace,
   * and a moment for the exits that causes to reach the host.
   */
  async close(): Promise<void> {
    const records = [...this.running.values()]
    for (const record of records) signalGroup(record.group, 'SIGTERM')
    const grace = Math.max(0, ...records.map(record => record.graceMs))
    await Promise.race([Promise.all(records.map(record => record.gone)), delay(grace)])
    for (const record of records) signalGroup(record.group, 'SIGKILL')
    await Promise.race([Promise.all(records.map(record => record.reported)), delay(REPORT_AFTER_KILL_MS)])
  }

  /** Send a stream's bytes to the host as they come. */
  private forward(id: string, name: 'stdout' | 'stderr', stream: Readable): Forwarded {
    this.outputs.add(stream)
    if (this.paused) stream.pause()
    stream.on('data', (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += OUTPUT_CHUNK_BYTES) {
        const data = chunk.subarray(offset, offset + OUTPUT_CHUNK_BYTES).toString('base64')
        if (!this.channel.send({ type: 'output', process: id, stream: name, data })) this.pause()
      }
    })
    const closed = new Promise<void>((resolve) => {
      stream.once('close', () => {
        this.outputs.delete(stream)
        resolve()
      })
    })
    return { stream, closed }
  }

  /**
   * Report an exit once its output has ended, or after its grace when
   * something it started keeps the output open; output after that is dropped.
   */
  private async finish(
    id: string, record: Running, outputs: Forwarded[], exitCode: number | null, signal: NodeJS.Signals | null,
  ): Promise<void> {
    const drained = await Promise.race([Promise.all(outputs.map(output => output.closed)).then(() => true), delay(record.graceMs, false)])
    if (!drained) for (const output of outputs) output.stream.destroy()
    this.channel.send({ type: 'exit', process: id, exitCode, signal })
  }

  private pause(): void {
    if (this.paused) return
    this.paused = true
    for (const stream of this.outputs) stream.pause()
  }

  private async untilEmpty(group: number): Promise<void> {
    while (groupExists(group)) await delay(POLL_MS)
  }
}

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal)
  } catch {
    // The group is already empty.
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
