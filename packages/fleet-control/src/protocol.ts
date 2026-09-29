/**
 * The fleet host's control protocol, spoken over a Unix socket in the dsh
 * home that only its owner can open. Each connection carries one request:
 * the client writes it as one JSON line, and the host answers with JSON
 * lines, any `session` frames first, then one `result` or `error`, and closes
 * the connection. A client that goes away only stops the host waiting for
 * it; the session keeps running. This module has no dsh dependency, so the
 * `fleet` command loads it without dsh.
 * @module fleet-control/protocol
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

/** Bumped when a request or result changes shape; the host refuses other versions. */
export const PROTOCOL_VERSION = 2

/** Longest request line the host reads. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024

const session = z.string().min(1)
/** A session refuses a prompt without text, and a `run` would already have made its session. */
const prompt = z.string().refine(text => text.trim() !== '', 'the prompt is empty')

/**
 * What a `run` asks of its session: a prompt as it is, or an agent directory
 * in the tau format, which the host reads, fills with the arguments and
 * titles the session after.
 */
const agentFields = {
  /** The agent directory, absolute. */
  agent: z.string().min(1),
  args: z.array(z.string()),
  /** The command's working folder, which relative path arguments are resolved against. */
  callerCwd: z.string().min(1),
  /** The command's values of the variables the agent's tau.json lists; the command reads that list itself. */
  env: z.record(z.string(), z.string()),
}

const taskSchema = z.union([
  z.object({ prompt }).strict(),
  z.object(agentFields).strict(),
])

export type Task = z.infer<typeof taskSchema>

export const requestSchema = z.discriminatedUnion('op', [
  /**
   * Start a session in `cwd` with a task; `wait` stays until it is idle. `ts`
   * gives it the TypeScript tools, which an agent declaring services or
   * shipping modules gets anyway.
   */
  z.object({ op: z.literal('run'), cwd: z.string().min(1), task: taskSchema, wait: z.boolean() }),
  /** Send `prompt` to a session, queued as a later turn or, with `steer`, into the running one. */
  z.object({ op: z.literal('send'), session, prompt, steer: z.boolean(), wait: z.boolean() }),
  /** Wait until a session is idle, and report its last turn. */
  z.object({ op: z.literal('wait'), session }),
  z.object({ op: z.literal('list') }),
  /** Cancel a session's running turn; its queued messages stay. */
  z.object({ op: z.literal('cancel'), session }),
  /** Stop a session's container unless something of the session runs. */
  z.object({ op: z.literal('stop'), session }),
  /** Archive a session, which removes its container; `force` stops what runs instead of refusing. */
  z.object({ op: z.literal('archive'), session, force: z.boolean() }),
  /**
   * Read an agent directory as a run in `cwd` would, and report its problems;
   * the arguments are bound only when `bind`.
   */
  z.object({ op: z.literal('check'), ...agentFields, cwd: z.string().min(1), bind: z.boolean() }),
  /** The services fleet's plugins provide. */
  z.object({ op: z.literal('services') }),
])

export type Request = z.infer<typeof requestSchema>
export type Op = Request['op']

/** How a session's last turn ended. */
export interface Outcome {
  /** dsh's turn-end reason, such as `completed`, `aborted` or `error`; null when no turn ended. */
  reason: string | null
  /** The turn's last assistant text, empty when it wrote none. */
  text: string
  /** The failure of a turn that ended in `error`. */
  error?: { code: string; message: string }
  /** Why the run did not give back its outputs, its out and inout paths, after its completed turn; absent when it did, or it has none. */
  outputs?: string[]
}

/** One session in a list. */
export interface SessionRow {
  session: string
  title?: string
  cwd?: string
  running: boolean
  /** Latest activity, in epoch milliseconds. */
  updatedAt: number
}

/** A service fleet's plugins provide. */
export interface ServiceRow {
  name: string
  description?: string
  /** The service's manifest in its canonical form, to copy into an agent's services/<name>.d.ts. */
  declarations: string
  functions: string[]
}

/** The result of each request. */
export interface Results {
  run: { session: string; outcome?: Outcome }
  send: { outcome?: Outcome }
  wait: { outcome: Outcome }
  list: { sessions: SessionRow[] }
  cancel: Record<string, never>
  /** `activity` names what keeps the container running, such as `turn` or `terminal`. */
  stop: { stopped: true } | { stopped: false; activity: string[] }
  archive: Record<string, never>
  /** Every problem that would refuse a run; none when it would start. */
  check: { problems: string[] }
  services: { services: ServiceRow[] }
}

/** One line the host writes. */
export type Frame =
  /** The session a `run` started, sent once its task is accepted, before the host waits on it. */
  | { type: 'session'; session: string }
  | { type: 'result'; value: unknown }
  | { type: 'error'; code: string; message: string }

/**
 * The dsh home, resolved as dsh resolves it: `$DSH_HOME` unless blank, else
 * `~/.dsh`, with a leading `~` expanded.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  return resolve(configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured)
}

/** The control socket of the fleet host serving a dsh home. */
export function socketPath(home: string): string {
  return join(home, 'fleet', 'control.sock')
}

/**
 * Split a byte stream into lines as they arrive.
 * @param onLine - called with each complete line, without its newline.
 * @param maxBytes - longest line accepted.
 * @returns a data handler, which throws on a longer line.
 */
export function lineReader(onLine: (line: string) => void, maxBytes: number): (chunk: Buffer) => void {
  let pending: Buffer[] = []
  let pendingBytes = 0
  return (chunk) => {
    let start = 0
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      pending.push(chunk.subarray(start, index))
      const line = Buffer.concat(pending).toString('utf8')
      pending = []
      pendingBytes = 0
      start = index + 1
      onLine(line)
    }
    if (start < chunk.length) {
      pendingBytes += chunk.length - start
      if (pendingBytes > maxBytes) throw new Error(`fleet-control: a line is longer than ${maxBytes} bytes`)
      pending.push(chunk.subarray(start))
    }
  }
}
