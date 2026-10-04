/**
 * The helper. The host starts it in a box with `docker exec --interactive`,
 * and it answers the host's requests over its stdin and stdout
 * (./protocol.ts) until its stdin ends; then it ends the processes, terminals
 * and watches it started, and exits. It also relays the calls of the
 * extensions' clients in the box to the host (./cmd/calls.ts).
 * @module fleet-image/helper/main
 */

import { createInterface } from 'node:readline'
import { CallSocket } from './cmd/calls.ts'
import { exec } from './cmd/exec.ts'
import {
  fsEditText, fsListDir, fsLstat, fsReadBytes, fsReadRange, fsReadText, fsResolve, fsStat, fsUnwatch, fsWatch, fsWriteText, unwatchAll,
} from './cmd/fs.ts'
import { apisLink } from './cmd/link.ts'
import { kill, killAll, spawn, which } from './cmd/spawn.ts'
import { endAll, terminal, terminalEnd, terminalForeground, terminalResize, terminalSignal, terminalWrite } from './cmd/terminal.ts'
import { PROTOCOL_VERSION, type EventOf, type HelperMessage, type HostMessage, type Method, type Methods } from './protocol.ts'

// Node names its main thread `node-MainThread`, which a `pkill node` in the box would match.
process.title = 'fleet-helper'

/** Sends one of the request's events; false when the host has fallen behind. */
type Emit<M extends Method> = (event: EventOf<M>) => boolean

type Handlers = {
  [M in Method]: (params: Methods[M]['params'], emit: Emit<M>) => Promise<Methods[M]['result']> | Methods[M]['result']
}

const handlers: Handlers = {
  hello: () => ({ protocol: PROTOCOL_VERSION, methods: Object.keys(handlers) }),
  echo: (params) => {
    if (typeof params?.text !== 'string') throw new Error('echo takes a text')
    return { text: params.text }
  },
  exec,
  'fs.resolve': fsResolve,
  'fs.stat': fsStat,
  'fs.lstat': fsLstat,
  'fs.readText': fsReadText,
  'fs.readBytes': fsReadBytes,
  'fs.readRange': fsReadRange,
  'fs.listDir': fsListDir,
  'fs.writeText': fsWriteText,
  'fs.editText': fsEditText,
  'fs.watch': fsWatch,
  'fs.unwatch': fsUnwatch,
  spawn: (params, emit) => spawn(params, { send: emit, onDrain: (listener) => { process.stdout.on('drain', listener) } }),
  kill,
  which,
  terminal: (params, emit) => terminal(params, { send: emit, onDrain: (listener) => { process.stdout.once('drain', listener) } }),
  'terminal.write': terminalWrite,
  'terminal.resize': terminalResize,
  'terminal.foreground': terminalForeground,
  'terminal.signal': terminalSignal,
  'terminal.end': terminalEnd,
  'apis.link': apisLink,
}

/** Requests not answered yet. */
const inFlight = new Set<Promise<void>>()

// Before any request, so that every process the helper starts finds the socket. Without it, only calls fail.
const calls = await CallSocket.listen(send).catch((error: unknown) => {
  process.stderr.write(`fleet-helper: no call socket: ${error instanceof Error ? error.message : String(error)}\n`)
  return undefined
})

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  let message: HostMessage
  try {
    message = JSON.parse(line) as HostMessage
  } catch {
    process.stderr.write('fleet-helper: unreadable message\n')
    return
  }
  if (message.type === 'call-result' || message.type === 'call-error') {
    calls?.answer(message)
    return
  }
  const handled = handle(message)
  inFlight.add(handled)
  void handled.finally(() => { inFlight.delete(handled) })
})
// The host has gone, or is done with the box: what it asked is answered, its processes, terminals and watches ended first.
lines.once('close', () => {
  void Promise.allSettled([killAll(), endAll(), unwatchAll(), calls?.close()])
    .then(() => Promise.allSettled([...inFlight]))
    .finally(() => { process.exit(0) })
})

async function handle(request: Extract<HostMessage, { type: 'request' }>): Promise<void> {
  const { id, method, params } = request
  try {
    if (!Object.hasOwn(handlers, method)) throw new Error(`unknown method ${method}`)
    const emit = (value: unknown): boolean => send({ type: 'event', id, value })
    send({ type: 'result', id, value: await handlers[method as Method](params as never, emit as never) })
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    send({ type: 'error', id, message: error instanceof Error ? error.message : String(error), ...typeof code === 'string' ? { code } : {} })
  }
}

function send(message: HelperMessage): boolean {
  return process.stdout.write(`${JSON.stringify(message)}\n`)
}
