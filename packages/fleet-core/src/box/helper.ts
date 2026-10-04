/**
 * The host's end of a helper (fleet-image/helper/protocol): it starts the
 * helper with a command, completes the handshake, and matches answers, and
 * the events before them, to requests. The calls that clients in the box
 * make it hands to whoever started it, and sends their answers back.
 * Whatever runs in the box can impersonate the helper, so every message is
 * checked before it is used, and a helper that breaks the protocol loses its
 * connection. A connection never reconnects.
 * @module fleet-core/box/helper
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { PROTOCOL_VERSION, type Call, type EventOf, type HelperMessage, type HostMessage, type Method, type Methods } from 'fleet-image/helper/protocol'
import { isExecResult } from './cmd/exec.ts'
import { isDirEntries, isEditOutcome, isInfoOrNull, isPathInfoOrNull, isString, isTarget, isWatchEvent, isWriteOutcome } from './cmd/fs.ts'
import { isNull, isPath, isSpawnEvent, isSpawnResult } from './cmd/spawn.ts'
import { isForeground, isGroupId, isTerminalEvent } from './cmd/terminal.ts'
import { isTsOutcome } from './cmd/ts.ts'

/** A failure the helper reported for one request, with its code, such as an `FsError`'s, if it had one. */
export class HelperError extends Error {
  override name = 'HelperError'

  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

/**
 * Answers a call a client in the box makes, with JSON, or fails with what
 * the client is told. Its signal aborts when the caller has gone, or the
 * connection ends.
 */
export type CallHandler = (call: Call, signal: AbortSignal) => Promise<unknown>

/** What each method's result must look like. */
const results: { [M in Method]: (value: unknown) => value is Methods[M]['result'] } = {
  // A helper older than its `methods` answers without them, which the handshake reports.
  hello: (value): value is Methods['hello']['result'] => isRecord(value) && typeof value.protocol === 'number'
    && (value.methods === undefined || (Array.isArray(value.methods) && value.methods.every(method => typeof method === 'string'))),
  echo: (value): value is Methods['echo']['result'] => isRecord(value) && typeof value.text === 'string',
  exec: isExecResult,
  'fs.resolve': isTarget,
  'fs.stat': isInfoOrNull,
  'fs.lstat': isPathInfoOrNull,
  'fs.readText': isString,
  'fs.readBytes': isString,
  'fs.readRange': isString,
  'fs.listDir': isDirEntries,
  'fs.writeText': isWriteOutcome,
  'fs.editText': isEditOutcome,
  'fs.watch': isNull,
  'fs.unwatch': isNull,
  spawn: isSpawnResult,
  kill: isNull,
  which: isPath,
  terminal: isSpawnResult,
  'terminal.write': isNull,
  'terminal.resize': isNull,
  'terminal.foreground': isForeground,
  'terminal.signal': isGroupId,
  'terminal.end': isNull,
  'apis.link': isNull,
  'ts.execute': isTsOutcome,
  'ts.cancel': isNull,
}

/** What each method's events must look like; a method not here sends none. */
const events: { [M in Method]?: (value: unknown) => value is EventOf<M> } = {
  spawn: isSpawnEvent,
  'fs.watch': isWatchEvent,
  terminal: isTerminalEvent,
}

/** The methods a helper takes. */
export const METHODS = Object.keys(results) as Method[]

interface Pending {
  method: Method
  resolve(value: unknown): void
  reject(error: Error): void
  event?: (value: unknown) => void
}

export class Helper {
  private readonly pending = new Map<number, Pending>()
  /** The calls being answered, by the helper's id. */
  private readonly calls = new Map<number, AbortController>()
  private readonly exited: Promise<void>
  private nextId = 1
  private stderr = ''
  private failure: Error | undefined
  private closing: Promise<void> | undefined

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly onCall: CallHandler) {
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
   * @param onCall - answers the calls of the clients in the box; without it, each fails.
   */
  static async start(command: readonly [string, ...string[]], onCall: CallHandler = refuseCalls): Promise<Helper> {
    const [file, ...args] = command
    const helper = new Helper(spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] }), onCall)
    try {
      const { protocol, methods } = await helper.request('hello', {})
      if (protocol !== PROTOCOL_VERSION) {
        throw new Error(`fleet: the helper speaks protocol ${protocol}, not ${PROTOCOL_VERSION}; rebuild the image with \`pnpm image\``)
      }
      // A box keeps the image it was made from, so a rebuilt image reaches only boxes made after it.
      const missing = methods === undefined ? undefined : METHODS.filter(method => !methods.includes(method))
      if (missing === undefined || missing.length > 0) {
        const lacks = missing === undefined ? 'does not list its methods' : `serves no ${missing.join(', ')}`
        throw new Error(`fleet: the helper ${lacks}: its box was made from an older image than this host's; a new box gets the current one`)
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
   * @param onEvent - told each checked event the request sends before its result.
   * @returns its checked result; a failure the helper reports is a {@link HelperError}.
   */
  request<M extends Method>(method: M, params: Methods[M]['params'], onEvent?: (event: EventOf<M>) => void): Promise<Methods[M]['result']> {
    if (!Object.hasOwn(results, method)) return Promise.reject(new Error(`fleet: no method ${method}`))
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, event: onEvent as ((value: unknown) => void) | undefined })
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
    if (message?.type === 'call') {
      this.answer(message)
      return
    }
    if (message?.type === 'call-cancel') {
      this.calls.get(message.id)?.abort(new Error('fleet: the caller in the box has gone'))
      return
    }
    const pending = message === undefined ? undefined : this.pending.get(message.id)
    if (message === undefined || pending === undefined) {
      this.fail(new Error('fleet: the helper broke the protocol'))
      this.child.kill()
      return
    }
    if (message.type === 'event') {
      const check = events[pending.method]
      if (check?.(message.value) === true) pending.event?.(message.value)
      else this.break(new Error(`fleet: the helper sent ${pending.method} an unexpected event`))
      return
    }
    this.pending.delete(message.id)
    if (message.type === 'error') pending.reject(new HelperError(message.message, message.code))
    else if (results[pending.method](message.value)) pending.resolve(message.value)
    else {
      const error = new Error(`fleet: the helper answered ${pending.method} with an unexpected value`)
      pending.reject(error)
      this.break(error)
    }
  }

  /** Answer a call, unless one with its id is being answered, which breaks the protocol. */
  private answer({ id, api, method, args }: Call & { id: number }): void {
    if (this.calls.has(id)) {
      this.break(new Error('fleet: the helper sent a call with an id in use'))
      return
    }
    const controller = new AbortController()
    this.calls.set(id, controller)
    void (async () => {
      let reply: HostMessage
      try {
        const value = await this.onCall({ api, method, args }, controller.signal)
        reply = { type: 'call-result', id, value: value ?? null }
        // What is not JSON fails here, not in the box.
        JSON.stringify(reply)
      } catch (error) {
        reply = { type: 'call-error', id, message: error instanceof Error ? error.message : String(error) }
      }
      this.calls.delete(id)
      if (!controller.signal.aborted && this.failure === undefined) this.send(reply)
    })()
  }

  /** End a connection whose helper broke the protocol. */
  private break(error: Error): void {
    this.fail(error)
    this.child.kill()
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const call of this.calls.values()) call.abort(error)
  }
}

function refuseCalls(call: Call): Promise<never> {
  return Promise.reject(new Error(`fleet: this box serves no calls, so none to ${call.api}.${call.method}`))
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
  if ((value.type === 'result' || value.type === 'event') && Object.hasOwn(value, 'value')) return value as HelperMessage
  if (value.type === 'error' && typeof value.message === 'string' && (value.code === undefined || typeof value.code === 'string')) {
    return value as HelperMessage
  }
  if (value.type === 'call' && typeof value.api === 'string' && typeof value.method === 'string' && Array.isArray(value.args)) {
    return { type: 'call', id: value.id as number, api: value.api, method: value.method, args: value.args as unknown[] }
  }
  if (value.type === 'call-cancel') return { type: 'call-cancel', id: value.id as number }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
