/**
 * The helper. The host starts it in a box with `docker exec --interactive`,
 * and it answers the host's requests over its stdin and stdout
 * (./protocol.ts) until its stdin ends; then it ends the processes it started
 * and exits.
 * @module fleet-image/helper/main
 */

import { createInterface } from 'node:readline'
import { exec } from './cmd/exec.ts'
import { fsEditText, fsListDir, fsLstat, fsReadBytes, fsReadRange, fsReadText, fsResolve, fsStat, fsWriteText } from './cmd/fs.ts'
import { kill, killAll, spawn, which } from './cmd/spawn.ts'
import { PROTOCOL_VERSION, type EventOf, type HelperMessage, type HostMessage, type Method, type Methods } from './protocol.ts'

// Node names its main thread `node-MainThread`, which a `pkill node` in the box would match.
process.title = 'fleet-helper'

/** Sends one of the request's events; false when the host has fallen behind. */
type Emit<M extends Method> = (event: EventOf<M>) => boolean

type Handlers = {
  [M in Method]: (params: Methods[M]['params'], emit: Emit<M>) => Promise<Methods[M]['result']> | Methods[M]['result']
}

const handlers: Handlers = {
  hello: () => ({ protocol: PROTOCOL_VERSION }),
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
  spawn: (params, emit) => spawn(params, { send: emit, onDrain: (listener) => { process.stdout.on('drain', listener) } }),
  kill,
  which,
}

/** Requests not answered yet. */
const inFlight = new Set<Promise<void>>()

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const handled = handle(line)
  inFlight.add(handled)
  void handled.finally(() => { inFlight.delete(handled) })
})
// The host has gone, or is done with the box: what it asked is answered, its processes ended first.
lines.once('close', () => {
  void killAll().then(() => Promise.allSettled([...inFlight])).finally(() => { process.exit(0) })
})

async function handle(line: string): Promise<void> {
  let request: HostMessage
  try {
    request = JSON.parse(line) as HostMessage
  } catch {
    process.stderr.write('fleet-helper: unreadable message\n')
    return
  }
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
