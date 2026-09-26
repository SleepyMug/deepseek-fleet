/**
 * fleet-box's helper. The host starts it in a session container with
 * `docker exec --interactive`, and it serves that container's files and
 * processes over its stdin and stdout (./protocol.ts) until stdin ends, which
 * happens when the host closes the world or goes away; then it stops every
 * process it started and exits. Files go through dsh's own local file system,
 * so the model's file tools behave exactly as they do on a local machine. It
 * also watches and ends the terminals the host runs with `docker exec`
 * (./terminals.ts), which are not its processes.
 *
 * The image build compiles this directory on its own (image/helper), so it
 * imports nothing from the rest of fleet-box.
 * @module fleet-box/helper/main
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsEditRequest, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import {
  EXECUTABLE_NOT_FOUND, MAX_MESSAGE_BYTES, MAX_WRITE_TEXT, PROTOCOL_VERSION,
  type HelperMessage, type HostMessage, type SpawnParams, type WireError,
} from './protocol.ts'
import { Processes, type Channel } from './processes.ts'
import { endTerminal, terminalState, waitTerminal } from './terminals.ts'

// Node names its main thread `node-MainThread`, which a `pkill node` in the container would match.
process.title = 'fleet-box'

type Params = Record<string, unknown>
type Request = Extract<HostMessage, { type: 'request' }>

const MIB = 1024 * 1024
/** Characters of an error message sent to the host. */
const MAX_ERROR_MESSAGE = 16 * 1024

const channel: Channel = {
  send: (message) => {
    const line = encode(message)
    if (line === undefined) throw new Error(`a ${message.type} message does not fit in one line`)
    return write(line)
  },
  onDrain: (listener) => { process.stdout.on('drain', listener) },
}

const ctx = new Context()
// A write's answer carries the old text only below this size, which keeps it within a message.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd(), diffBasisMaxBytes: MAX_WRITE_TEXT })
const fs: FileSystem = ctx.fs

const processes = new Processes(channel)
/** Open text streams, read one chunk per request. */
const streams = new Map<number, { iterator: AsyncIterator<string>; controller: AbortController }>()
let nextStream = 1
/** Requests in progress, so the host can cancel them. */
const active = new Map<number, AbortController>()

const handlers: Record<string, (params: Params, signal: AbortSignal) => Promise<unknown>> = {
  hello: () => Promise.resolve({ protocol: PROTOCOL_VERSION, node: process.version }),

  'fs.resolve': (p, signal) => fs.resolve(text(p.path), { cwd: optionalText(p.cwd), signal }),
  'fs.stat': async (p, signal) => await fs.stat(target(p.target), signal) ?? null,
  'fs.lstat': async (p, signal) => await fs.lstat(text(p.path), { cwd: optionalText(p.cwd) }, signal) ?? null,
  'fs.readText': (p, signal) => fs.readText(target(p.target), signal),
  'fs.readBytes': async (p, signal) => base64(await fs.readBytes(target(p.target), signal, count(p.maxBytes))),
  'fs.readRange': async (p, signal) =>
    base64(await fs.readByteRange(target(p.target), { offset: count(p.offset), length: count(p.length) }, signal)),
  'fs.listDir': (p, signal) => fs.listDir(target(p.target), signal),
  'fs.writeText': async (p, signal) => {
    const file = target(p.target)
    const content = text(p.content)
    if (content.length > MAX_WRITE_TEXT) {
      throw new FsError(`cannot write "${file.displayPath}": the content is over the container's ${MAX_WRITE_TEXT / MIB} MiB limit `
        + 'for file writes; write it with a command instead', 'FS_TOO_LARGE')
    }
    return fs.writeText(file, content, (p.expected ?? undefined) as FsWriteIntent | undefined, signal)
  },
  'fs.editText': async (p, signal) => {
    const file = target(p.target)
    const edit = p.edit as FsEditRequest
    await checkEdit(file, edit, signal)
    return fs.editText(file, edit, (p.expected ?? undefined) as { version: FsVersion } | undefined, signal)
  },
  'fs.streamOpen': async (p, signal) => {
    // The stream outlives this request, so it gets its own cancellation.
    const controller = new AbortController()
    const iterable = await fs.streamText(target(p.target), AbortSignal.any([signal, controller.signal]))
    const id = nextStream++
    streams.set(id, { iterator: iterable[Symbol.asyncIterator](), controller })
    return id
  },
  'fs.streamNext': async (p) => {
    const id = count(p.stream)
    const stream = streams.get(id)
    if (stream === undefined) throw new Error(`unknown text stream ${id}`)
    const next = await stream.iterator.next()
    if (next.done === true) streams.delete(id)
    return { done: next.done === true, value: next.done === true ? '' : next.value }
  },
  'fs.streamClose': async (p) => {
    const id = count(p.stream)
    const stream = streams.get(id)
    streams.delete(id)
    stream?.controller.abort(new Error('the host closed the stream'))
    await stream?.iterator.return?.()
    return null
  },

  'process.spawn': p => processes.spawn(p as unknown as SpawnParams),
  'process.terminate': (p) => {
    processes.terminate(text(p.process))
    return Promise.resolve(null)
  },
  'process.wait': (p, signal) => processes.wait(text(p.process), signal),
  executable: p => findExecutable(text(p.command), (p.env ?? null) as Record<string, string> | null),

  'terminal.state': p => terminalState(terminalId(p.terminal)),
  'terminal.end': async (p, signal) => {
    await endTerminal(terminalId(p.terminal), count(p.graceMs), signal)
    return null
  },
  'terminal.wait': async (p, signal) => {
    await waitTerminal(terminalId(p.terminal), signal)
    return null
  },
}

function handle(message: HostMessage): void {
  if (message.type === 'cancel') {
    active.get(message.id)?.abort(new Error('the host cancelled the request'))
    return
  }
  const controller = new AbortController()
  active.set(message.id, controller)
  const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined
  const run = handler === undefined
    ? Promise.reject(new Error(`unknown method ${message.method}`))
    : Promise.resolve().then(() => handler(message.params ?? {}, controller.signal))
  void run.then(
    (value) => { reply(message, value) },
    (error: unknown) => { refuse(message, error) },
  ).finally(() => { active.delete(message.id) })
}

/** Answer a request, or refuse it when the answer does not fit in a message. */
function reply(request: Request, value: unknown): void {
  let line: string | undefined
  try {
    line = encode({ type: 'result', id: request.id, value: value ?? null })
  } catch (error) {
    refuse(request, error)
    return
  }
  if (line !== undefined) {
    write(line)
    return
  }
  const path = (request.params.target as { displayPath?: unknown } | undefined)?.displayPath
  const subject = typeof path === 'string' ? `"${path}"` : `the answer to ${request.method}`
  refuse(request, new FsError(`cannot send ${subject} from the container: it is over the ${MAX_MESSAGE_BYTES / MIB} MiB message limit`, 'FS_TOO_LARGE'))
}

function refuse(request: Request, error: unknown): void {
  write(JSON.stringify({ type: 'error', id: request.id, error: wireError(error) } satisfies HelperMessage))
}

/** @returns the message as one line, or undefined when it is longer than a message may be. */
function encode(message: HelperMessage): string | undefined {
  let line: string
  try {
    line = JSON.stringify(message)
  } catch (error) {
    // V8 refuses to build a string past its own limit.
    if (error instanceof RangeError) return undefined
    throw error
  }
  return Buffer.byteLength(line) > MAX_MESSAGE_BYTES ? undefined : line
}

function write(line: string): boolean {
  return process.stdout.write(`${line}\n`)
}

/**
 * Refuse an edit whose text before or after could be longer than
 * {@link MAX_WRITE_TEXT}, before the file changes. It reckons from the
 * file's size, which bounds its text, and the most matches it can hold; the
 * edit itself reports a missing or irregular file and an empty search.
 */
async function checkEdit(file: FsTarget, edit: FsEditRequest, signal: AbortSignal): Promise<void> {
  const info = await fs.stat(file, signal)
  if (info?.type !== 'file' || info.size === undefined) return
  const removed = text(edit.oldString).replaceAll('\r\n', '\n').length
  const added = text(edit.newString).replaceAll('\r\n', '\n').length
  if (removed === 0) return
  const matches = edit.replaceAll ? Math.floor(info.size / removed) : 1
  if (Math.max(info.size, info.size + matches * (added - removed)) > MAX_WRITE_TEXT) {
    throw new FsError(`cannot edit "${file.displayPath}": the file could be over the container's ${MAX_WRITE_TEXT / MIB} MiB limit `
      + 'for file edits; edit it with a command instead', 'FS_TOO_LARGE')
  }
}

let stopping: Promise<void> | undefined
/** Stop everything this helper started, then exit. */
function shutdown(): Promise<void> {
  stopping ??= (async () => {
    for (const controller of active.values()) controller.abort(new Error('the host went away'))
    for (const stream of streams.values()) stream.controller.abort(new Error('the host went away'))
    await Promise.allSettled([...streams.values()].map(stream => stream.iterator.return?.()))
    await processes.close()
    process.exit(0)
  })()
  return stopping
}

process.stdout.on('error', () => { void shutdown() })
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  let message: HostMessage
  try {
    message = JSON.parse(line) as HostMessage
  } catch {
    process.stderr.write('fleet-box helper: ignored a line that is not JSON\n')
    return
  }
  handle(message)
})
lines.once('close', () => { void shutdown() })

/** @returns the executable's path as found, not its target, since some programs act on the name they were run by. */
async function findExecutable(command: string, env: Record<string, string> | null): Promise<string> {
  if (command === '') throw new Error('the command is empty')
  if (command.includes('/')) {
    if (!isAbsolute(command)) throw new Error(`${command} is a relative path; give an absolute path or a bare name`)
    if (await isExecutable(command)) return command
    throw notFound(command)
  }
  for (const folder of (env?.PATH ?? process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(folder)) continue
    const candidate = join(folder, command)
    if (await isExecutable(candidate)) return candidate
  }
  throw notFound(command)
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function notFound(command: string): Error {
  return Object.assign(new Error(`${command} was not found in the container`), { code: EXECUTABLE_NOT_FOUND })
}

function wireError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error).slice(0, MAX_ERROR_MESSAGE) }
  const code = (error as { code?: unknown }).code
  return { name: error.name, message: error.message.slice(0, MAX_ERROR_MESSAGE), ...(typeof code === 'string' ? { code } : {}) }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected a string')
  return value
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : text(value)
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('expected a non-negative integer')
  return value
}

/** A terminal id as the host makes them; it is matched against environment entries. */
function terminalId(value: unknown): string {
  const id = text(value)
  if (!/^[\w-]{1,128}$/u.test(id)) throw new Error('expected a terminal id')
  return id
}

function target(value: unknown): FsTarget {
  const fields = value as { targetKey?: unknown; displayPath?: unknown } | null
  text(fields?.targetKey)
  text(fields?.displayPath)
  return value as FsTarget
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}
