/**
 * The host's end of one session container's helper. It starts the helper
 * with `docker exec --interactive`, sends it requests, and routes its answers
 * and process events (fleet-image/helper/protocol), and the service calls it relays
 * to whoever serves them ({@link HelperConnection.serveCalls}). Everything
 * the helper sends is bounded and validated, since the model is root in the
 * same container.
 *
 * A connection never reconnects. When the helper or its Docker CLI ends
 * without being asked to, every pending request fails, every running process
 * is reported lost, and `ended` tells the world's owner to tear the world down.
 * @module fleet-runtime/box/connection
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:os'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, type HostMessage } from 'fleet-image/helper/protocol'
import { z } from 'zod'
import { ServiceCalls, type CallHandler } from './calls.ts'

/** Characters of the helper's stderr kept to explain a failed start. */
const STDERR_TAIL = 4096
/** How long the helper gets to answer its handshake, or a later check that it still answers. */
const HELLO_TIMEOUT_MS = 30_000
/** How long the helper gets to stop its processes and exit once its stdin ends. */
const CLOSE_TIMEOUT_MS = 15_000
const CLOSED = 'fleet-box: the helper connection is closed'

export interface ConnectionOptions {
  /** Docker CLI executable. */
  docker: string
  /** Name of the running container. */
  container: string
  /** Folder the helper starts in, the same in the container and on the host. */
  workspace: string
  /** Node executable inside the container. */
  node: string
  /** Helper entry inside the container. */
  entry: string
}

/** A failure the helper reported for one request; `code` is a dsh-fs error code or the helper's own. */
export class HelperError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message)
    this.name = 'HelperError'
  }
}

export type { CallHandler, ServiceCallRequest } from './calls.ts'

/** Receives one process's events. */
export interface ProcessListener {
  output(stream: 'stdout' | 'stderr', data: Buffer): void
  exit(exitCode: number | null, signal: NodeJS.Signals | null): void
  /** The connection ended before the process's exit arrived. */
  lost(error: Error): void
}

const signalSchema = z.string().refine(name => name in constants.signals).transform(name => name as NodeJS.Signals)
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), id: z.number().int(), value: z.unknown() }),
  z.object({ type: z.literal('error'), id: z.number().int(), error: z.object({ name: z.string(), message: z.string(), code: z.string().optional() }) }),
  z.object({ type: z.literal('output'), process: z.string(), stream: z.enum(['stdout', 'stderr']), data: z.base64() }),
  z.object({ type: z.literal('exit'), process: z.string(), exitCode: z.number().int().nullable(), signal: signalSchema.nullable() }),
  z.object({ type: z.literal('call'), call: z.number().int(), service: z.string(), function: z.string(), args: z.array(z.unknown()) }),
  z.object({ type: z.literal('call-cancel'), call: z.number().int() }),
])
const helloSchema = z.object({ protocol: z.number(), node: z.string() })

interface Pending {
  method: string
  schema: z.ZodType
  resolve(value: unknown): void
  reject(error: unknown): void
}

export class HelperConnection {
  /** Settles with what ended the connection when anything but {@link close} did. */
  readonly ended: Promise<Error>

  private readonly options: ConnectionOptions
  private readonly markEnded: (error: Error) => void
  private readonly pending = new Map<number, Pending>()
  private readonly processes = new Map<string, ProcessListener>()
  private readonly calls = new ServiceCalls((line) => { this.sendLine(line) })
  private nextId = 1
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> = Promise.resolve()
  private stderr = ''
  private failure: Error | undefined
  private closing: Promise<void> | undefined

  constructor(options: ConnectionOptions) {
    this.options = options
    const ended = Promise.withResolvers<Error>()
    this.ended = ended.promise
    this.markEnded = ended.resolve
  }

  /** Start the helper and check that it speaks this protocol. */
  async start(): Promise<void> {
    const { docker, container, workspace, node, entry } = this.options
    // A stray SIGUSR1 in the container would open Node's inspector in the helper.
    const child = spawn(docker, ['exec', '--interactive', '--workdir', workspace, container, node, '--disable-sigusr1', entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL) })
    // A write after the helper is gone fails here; its exit reports the loss.
    child.stdin.on('error', () => {})
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => {
      this.fail(new Error(this.closing === undefined ? `fleet-box: the helper in ${container} exited${this.stderrNote()}` : CLOSED))
    })
    this.read(child.stdout)

    let hello: z.infer<typeof helloSchema>
    try {
      hello = await this.request('hello', {}, helloSchema, AbortSignal.timeout(HELLO_TIMEOUT_MS))
    } catch (error) {
      // Docker's or the helper's own message explains a failed start better than the closed pipe.
      await Promise.race([this.childClosed, delay(1000, undefined, { ref: false })])
      throw new Error(`fleet-box: the helper in ${container} did not start${this.stderrNote() || `: ${message(error)}`}`)
    }
    if (hello.protocol !== PROTOCOL_VERSION) {
      throw new Error(`fleet-box: the helper in ${container} speaks protocol ${hello.protocol}, not ${PROTOCOL_VERSION}; rebuild the image with \`pnpm image\` in the fleet checkout`)
    }
  }

  /**
   * Send one request; cancelling it does not undo what the helper already did.
   * @param method - the helper operation.
   * @param params - its fields, as JSON.
   * @param schema - validation of the answer.
   * @param signal - stops waiting and asks the helper to stop.
   * @returns the validated answer.
   */
  request<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id)
        this.send({ type: 'cancel', id })
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        method,
        schema,
        resolve: (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        },
      })
      this.send({ type: 'request', id, method, params })
    })
  }

  /**
   * Receive a process's events until its exit; register before spawning it.
   * @returns a function that stops the events.
   */
  watch(process: string, listener: ProcessListener): () => void {
    if (this.failure !== undefined) throw this.failure
    this.processes.set(process, listener)
    return () => {
      if (this.processes.get(process) === listener) this.processes.delete(process)
    }
  }

  /** Serve the service calls the helper relays; until then, and without one, every call fails. */
  serveCalls(handler: CallHandler): void {
    this.calls.serve(handler)
  }

  /**
   * Check that the helper still answers, as when a process it was asked to
   * stop has not ended long after its grace. A helper that does not answer,
   * such as in a paused container, is lost like one that exited.
   */
  async probe(): Promise<void> {
    try {
      await this.request('hello', {}, helloSchema, AbortSignal.timeout(HELLO_TIMEOUT_MS))
    } catch {
      this.fail(new Error(`fleet-box: the helper in ${this.options.container} stopped answering`))
    }
  }

  /** End the helper, which stops every process it started; the world's teardown, which reports nothing. */
  close(): Promise<void> {
    this.closing ??= this.closeOnce()
    return this.closing
  }

  private async closeOnce(): Promise<void> {
    const child = this.child
    if (child !== undefined) {
      child.stdin.end()
      const exited = await Promise.race([this.childClosed.then(() => true), delay(CLOSE_TIMEOUT_MS, false, { ref: false })])
      if (!exited) {
        child.kill('SIGKILL')
        await this.childClosed
      }
    }
    this.fail(new Error(CLOSED))
  }

  private send(message: HostMessage): void {
    this.sendLine(JSON.stringify(message))
  }

  private sendLine(line: string): void {
    if (this.failure !== undefined || this.child === undefined) return
    this.child.stdin.write(`${line}\n`)
  }

  /** Split the helper's stdout into lines, refusing any longer than a message may be. */
  private read(stdout: Readable): void {
    let parts: Buffer[] = []
    let size = 0
    const tooLong = (length: number): boolean => {
      if (length <= MAX_MESSAGE_BYTES) return false
      this.fail(new Error(`fleet-box: the helper in ${this.options.container} sent a message over ${MAX_MESSAGE_BYTES} bytes`))
      stdout.destroy()
      return true
    }
    stdout.on('data', (chunk: Buffer) => {
      let start = 0
      for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
        if (tooLong(size + newline - start)) return
        parts.push(chunk.subarray(start, newline))
        const line = Buffer.concat(parts).toString('utf8')
        parts = []
        size = 0
        start = newline + 1
        this.receive(line)
        if (this.failure !== undefined) return
      }
      size += chunk.length - start
      if (tooLong(size)) return
      if (start < chunk.length) parts.push(chunk.subarray(start))
    })
  }

  private receive(line: string): void {
    let parsed: z.infer<typeof messageSchema>
    try {
      parsed = messageSchema.parse(JSON.parse(line))
    } catch {
      this.fail(new Error(`fleet-box: the helper in ${this.options.container} sent an unreadable message`))
      return
    }
    switch (parsed.type) {
      case 'result':
      case 'error': {
        // A cancelled request can still be answered.
        const pending = this.pending.get(parsed.id)
        if (pending === undefined) return
        this.pending.delete(parsed.id)
        if (parsed.type === 'error') {
          pending.reject(new HelperError(parsed.error.message, parsed.error.code))
          return
        }
        const value = pending.schema.safeParse(parsed.value)
        if (value.success) pending.resolve(value.data)
        else {
          const error = new Error(`fleet-box: the helper in ${this.options.container} answered ${pending.method} with an unexpected value`)
          pending.reject(error)
          this.fail(error)
        }
        return
      }
      case 'output':
        this.processes.get(parsed.process)?.output(parsed.stream, Buffer.from(parsed.data, 'base64'))
        return
      case 'exit': {
        const listener = this.processes.get(parsed.process)
        this.processes.delete(parsed.process)
        listener?.exit(parsed.exitCode, parsed.signal)
        return
      }
      case 'call':
        this.calls.receive(parsed, Buffer.byteLength(line))
        return
      case 'call-cancel':
        this.calls.cancel(parsed.call)
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const listener of this.processes.values()) listener.lost(error)
    this.processes.clear()
    this.calls.abortAll(error)
    this.child?.kill('SIGTERM')
    if (this.closing === undefined) this.markEnded(error)
  }

  private stderrNote(): string {
    const text = this.stderr.trim()
    return text === '' ? '' : `: ${text}`
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
