/**
 * The host's end of a helper (fleet-image/helper/protocol): it starts the
 * helper with a command, completes the handshake, and matches answers to
 * requests. Whatever runs in the box can impersonate the helper, so every
 * message is checked before it is used, and a helper that breaks the
 * protocol loses its connection. A connection never reconnects.
 * @module fleet-core/box/helper
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { PROTOCOL_VERSION, type HelperMessage, type HostMessage, type Method, type Methods } from 'fleet-image/helper/protocol'
import { isExecResult } from './cmd/exec.ts'

/** A failure the helper reported for one request. */
export class HelperError extends Error {
  override name = 'HelperError'
}

/** What each method's result must look like. */
const results: { [M in Method]: (value: unknown) => value is Methods[M]['result'] } = {
  hello: (value): value is Methods['hello']['result'] => isRecord(value) && typeof value.protocol === 'number',
  echo: (value): value is Methods['echo']['result'] => isRecord(value) && typeof value.text === 'string',
  exec: isExecResult,
}

/** The methods a helper takes. */
export const METHODS = Object.keys(results) as Method[]

interface Pending {
  method: Method
  resolve(value: unknown): void
  reject(error: Error): void
}

export class Helper {
  private readonly pending = new Map<number, Pending>()
  private readonly exited: Promise<void>
  private nextId = 1
  private stderr = ''
  private failure: Error | undefined
  private closing: Promise<void> | undefined

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr += chunk })
    // A write after the helper is gone fails here; its exit reports the loss.
    child.stdin.on('error', () => {})
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => {
      const stderr = this.stderr.trim()
      this.fail(new Error(`fleet: the helper exited${stderr === '' ? '' : `: ${stderr}`}`))
    })
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => { this.receive(line) })
  }

  /**
   * Start a helper and complete its handshake.
   * @param command - what runs it, such as `docker exec --interactive …`.
   */
  static async start(command: readonly [string, ...string[]]): Promise<Helper> {
    const [file, ...args] = command
    const helper = new Helper(spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] }))
    try {
      const { protocol } = await helper.request('hello', {})
      if (protocol !== PROTOCOL_VERSION) {
        throw new Error(`fleet: the helper speaks protocol ${protocol}, not ${PROTOCOL_VERSION}; rebuild the image with \`pnpm image\``)
      }
    } catch (error) {
      await helper.close()
      throw error
    }
    return helper
  }

  /**
   * Send one request. A method that is not one of {@link METHODS}, as a
   * name typed at run time may be, is refused without sending it.
   * @returns its checked result; a failure the helper reports is a {@link HelperError}.
   */
  request<M extends Method>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    if (!Object.hasOwn(results, method)) return Promise.reject(new Error(`fleet: no method ${method}`))
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      this.send({ type: 'request', id, method, params })
    })
  }

  /** End the helper's stdin and wait for it to exit; pending and later requests fail. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.fail(new Error('fleet: the helper connection is closed'))
      this.child.stdin.end()
      await this.exited
    })()
    return this.closing
  }

  private send(message: HostMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    if (this.failure !== undefined) return
    const message = parse(line)
    const pending = message === undefined ? undefined : this.pending.get(message.id)
    if (message === undefined || pending === undefined) {
      this.fail(new Error('fleet: the helper broke the protocol'))
      this.child.kill()
      return
    }
    this.pending.delete(message.id)
    if (message.type === 'error') pending.reject(new HelperError(message.message))
    else if (results[pending.method](message.value)) pending.resolve(message.value)
    else {
      const error = new Error(`fleet: the helper answered ${pending.method} with an unexpected value`)
      pending.reject(error)
      this.fail(error)
      this.child.kill()
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/** A helper message, or undefined for anything else. */
function parse(line: string): HelperMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) return undefined
  if (value.type === 'result' && Object.hasOwn(value, 'value')) return value as HelperMessage
  if (value.type === 'error' && typeof value.message === 'string') return value as HelperMessage
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
