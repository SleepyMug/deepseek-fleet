/**
 * The host's end of a helper (fleet-protocol's helper): it starts the helper
 * with a command, completes the handshake, and matches answers, and the
 * events before them, to requests. Each connection a program in the box
 * opens to a service's socket it gives whoever started it as a stream, its
 * bytes and its end relayed both ways, no more than the window of them
 * unacknowledged each way, so that a side that reads slowly slows the other.
 * Whatever runs in the box can impersonate the helper, so every message is
 * checked before it is used, and a helper that breaks the protocol loses its
 * connection. A connection never reconnects.
 * @module @sleepymug/fleet/box/helper
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Duplex } from 'node:stream'
import {
  CONNECTION_WINDOW, PROTOCOL_VERSION, type EventOf, type HelperMessage, type HostMessage, type Method, type Methods,
} from '@sleepymug/fleet-protocol/helper'
import { isExecResult } from './cmd/exec.ts'
import { isDirEntries, isEditOutcome, isInfoOrNull, isPathInfoOrNull, isString, isTarget, isWatchEvent, isWriteOutcome } from './cmd/fs.ts'
import { isInstalled } from './cmd/services.ts'
import { isNull, isPath, isSpawnEvent, isSpawnResult } from './cmd/spawn.ts'
import { isActivity, isForeground, isGroupId, isTerminalEvent } from './cmd/terminal.ts'

/** A failure the helper reported for one request, with its code, such as an `FsError`'s, if it had one. */
export class HelperError extends Error {
  override name = 'HelperError'

  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

/**
 * Takes each connection a program in the box opens to a service's socket,
 * as a stream: what it reads is what the program sent, and what is written
 * to it reaches the program; its end is a half-close, either way, and its
 * destruction cuts the connection.
 */
export type ConnectionHandler = (service: string, connection: Duplex) => void

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
  'terminal.activity': isActivity,
  'terminal.signal': isGroupId,
  'terminal.end': isNull,
  'services.installed': isInstalled,
  'services.sync': isNull,
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
  /** The connections relayed, by the helper's id. */
  private readonly connections = new Map<number, Relayed>()
  private readonly exited: Promise<void>
  private nextId = 1
  private stderr = ''
  private failure: Error | undefined
  private closing: Promise<void> | undefined

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly onConnection: ConnectionHandler) {
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
   * @param onConnection - takes each connection a program in the box opens to a service's socket; without it, each is cut.
   */
  static async start(command: readonly [string, ...string[]], onConnection: ConnectionHandler = refuse): Promise<Helper> {
    const [file, ...args] = command
    const helper = new Helper(spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] }), onConnection)
    try {
      const { protocol, methods } = await helper.request('hello', {})
      if (protocol !== PROTOCOL_VERSION) {
        throw new Error(`fleet: the helper speaks protocol ${protocol}, not ${PROTOCOL_VERSION}; rebuild the image with \`fleet image build\``)
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

  /** End the helper's stdin and wait for it to exit; pending and later requests fail, and the connections are cut. */
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
    if (message === undefined) {
      this.break(new Error('fleet: the helper broke the protocol'))
      return
    }
    switch (message.type) {
      case 'conn-open': {
        if (this.connections.has(message.conn)) {
          this.break(new Error('fleet: the helper opened a connection with an id in use'))
          return
        }
        const relayed = new Relayed(message.conn, (sent) => { this.send(sent) }, () => { this.connections.delete(message.conn) })
        this.connections.set(message.conn, relayed)
        this.onConnection(message.service, relayed)
        return
      }
      case 'conn-data':
      case 'conn-ack':
      case 'conn-end':
        this.connections.get(message.conn)?.receive(message)
        return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) {
      this.break(new Error('fleet: the helper broke the protocol'))
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
    for (const connection of this.connections.values()) connection.destroy(error)
    this.connections.clear()
  }
}

/**
 * A connection relayed through the helper, as a stream: what the program in
 * the box sent comes to be read, acknowledged as it is read; what is written
 * goes to the box, a write waiting while the box has not acknowledged a
 * window's worth.
 */
class Relayed extends Duplex {
  /** What was sent to the box and not acknowledged. */
  private unacked = 0
  /** A write waiting for the box to catch up. */
  private waiting: (() => void) | undefined
  /** What was read and not yet acknowledged, while the reader is behind. */
  private owed = 0
  private behind = false
  /** The box's side sent its end, or was cut. */
  private boxDone = false
  /** This side sent its end. */
  private sentEnd = false

  constructor(private readonly conn: number, private readonly sendMessage: (message: HostMessage) => void, private readonly forget: () => void) {
    super({ allowHalfOpen: true })
    // Why a connection was cut reaches the box as its end; a taker that wants it listens too.
    this.on('error', () => {})
  }

  receive(message: Extract<HelperMessage, { type: 'conn-data' | 'conn-ack' | 'conn-end' }>): void {
    switch (message.type) {
      case 'conn-data': {
        const bytes = Buffer.from(message.data, 'base64')
        if (this.push(bytes) && !this.behind) this.sendMessage({ type: 'conn-ack', conn: this.conn, bytes: bytes.length })
        else {
          this.behind = true
          this.owed += bytes.length
        }
        return
      }
      case 'conn-ack':
        this.unacked -= message.bytes
        if (this.unacked < CONNECTION_WINDOW) {
          const resume = this.waiting
          this.waiting = undefined
          resume?.()
        }
        return
      case 'conn-end':
        this.boxDone = true
        if (message.error === undefined) this.push(null)
        else this.destroy(new Error(`fleet: ${message.error}`))
    }
  }

  override _read(): void {
    if (!this.behind) return
    this.behind = false
    const owed = this.owed
    this.owed = 0
    if (owed > 0) this.sendMessage({ type: 'conn-ack', conn: this.conn, bytes: owed })
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.unacked += chunk.length
    this.sendMessage({ type: 'conn-data', conn: this.conn, data: chunk.toString('base64') })
    if (this.unacked < CONNECTION_WINDOW) done()
    else this.waiting = () => { done() }
  }

  override _final(done: (error?: Error | null) => void): void {
    this.sentEnd = true
    this.sendMessage({ type: 'conn-end', conn: this.conn })
    done()
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    // Cut before both sides were done: the box's side is cut too.
    if (!this.boxDone || !this.sentEnd) this.sendMessage({ type: 'conn-end', conn: this.conn, error: error?.message ?? 'the service closed the connection' })
    this.waiting?.()
    this.forget()
    done(error)
  }
}

function refuse(_service: string, connection: Duplex): void {
  connection.destroy(new Error('this box serves no connections'))
}

/** A helper message, or undefined for anything else. */
function parse(line: string): HelperMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.type === 'conn-open' || value.type === 'conn-data' || value.type === 'conn-ack' || value.type === 'conn-end') {
    if (!Number.isSafeInteger(value.conn)) return undefined
    const conn = value.conn as number
    if (value.type === 'conn-open') return typeof value.service === 'string' ? { type: 'conn-open', conn, service: value.service } : undefined
    if (value.type === 'conn-data') return typeof value.data === 'string' ? { type: 'conn-data', conn, data: value.data } : undefined
    if (value.type === 'conn-ack') return Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0 ? { type: 'conn-ack', conn, bytes: value.bytes as number } : undefined
    if (value.error === undefined) return { type: 'conn-end', conn }
    return typeof value.error === 'string' ? { type: 'conn-end', conn, error: value.error } : undefined
  }
  if (!Number.isSafeInteger(value.id)) return undefined
  if ((value.type === 'result' || value.type === 'event') && Object.hasOwn(value, 'value')) return value as HelperMessage
  if (value.type === 'error' && typeof value.message === 'string' && (value.code === undefined || typeof value.code === 'string')) {
    return value as HelperMessage
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
