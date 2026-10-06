/**
 * The wire between the host and the helper in a box: one JSON message per
 * line over the stdin and stdout of the `docker exec` that runs the helper.
 * The host sends requests; the helper answers each exactly once, in any
 * order, and may send events for a request before it answers it. The other
 * way, the helper sends the calls that clients in the box make to the
 * host's extensions, which the host answers each once, unless the helper
 * cancels it first; a call, and an answer, may have bytes follow it, base64
 * in messages of their own, which the JSON of the call carries badly. The
 * helper exits when its stdin ends, and ends the
 * processes it started first. Shared by both ends, so it holds only types
 * and constants.
 * @module fleet-box-runtime/helper/protocol
 */

/** Wire version; the host refuses a helper that answers `hello` with another. */
export const PROTOCOL_VERSION = 1

/** The error code of a `which` for a program that is not there. */
export const EXECUTABLE_NOT_FOUND = 'EXECUTABLE_NOT_FOUND'

/** A file or folder as dsh's file system names it, by its canonical path in the box. */
export interface Target {
  targetKey: string
  displayPath: string
}

/** What `stat` and `listDir` say of a target. */
export interface Info {
  version: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** What `lstat` says of a path, symlinks not followed. */
export interface PathInfo {
  version: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
}

export interface DirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: Target
  version?: string
  size?: number
}

/** A write's precondition, as dsh's `FsWriteIntent` has it. */
export type WriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string }

export interface WriteOutcome {
  operation: 'create' | 'update'
  version: string
  before: string | null
  after: string
}

/** An edit, as dsh's `FsEditRequest` has it. */
export interface EditRequest {
  oldString: string
  newString: string
  replaceAll: boolean
}

export interface EditOutcome {
  version: string
  before: string
  after: string
}

/** Each method's params and result, and the events it sends before its result. */
export interface Methods {
  /**
   * The handshake: the wire version, and every method the helper serves, so
   * a host can tell a box made from an older image, whose helper may not
   * list them at all.
   */
  hello: { params: Record<string, never>; result: { protocol: number; methods?: string[] } }
  /** Answers with the text it was given. */
  echo: { params: { text: string }; result: { text: string } }
  /**
   * Runs a program, without a shell, and answers how it ended, with its exit
   * code or the signal that killed it, and all it wrote (./cmd/exec.ts).
   */
  exec: {
    params: { argv: string[] }
    result: { code: number | null; signal: string | null; stdout: string; stderr: string }
  }

  // dsh's file system, served in the box by dsh's own local one (./cmd/fs.ts).
  'fs.resolve': { params: { path: string; cwd?: string }; result: Target }
  'fs.stat': { params: { target: Target }; result: Info | null }
  'fs.lstat': { params: { path: string; cwd?: string }; result: PathInfo | null }
  'fs.readText': { params: { target: Target }; result: string }
  /** The bytes, base64. */
  'fs.readBytes': { params: { target: Target; maxBytes: number }; result: string }
  /** The bytes, base64. */
  'fs.readRange': { params: { target: Target; offset: number; length: number }; result: string }
  'fs.listDir': { params: { target: Target }; result: DirEntry[] }
  'fs.writeText': { params: { target: Target; content: string; expected?: WriteIntent }; result: WriteOutcome }
  'fs.editText': { params: { target: Target; edit: EditRequest; expected?: { version: string } }; result: EditOutcome }
  /**
   * Watches a target, under the host's id `watch`, and sends an event each
   * time it may have changed, with the error that ended the watching, if
   * one did; answers once `fs.unwatch` ends it.
   */
  'fs.watch': { params: { watch: string; target: Target }; result: null; event: { error: string | null } }
  /** Ends a watch, whose request then answers; nothing for a watch not there. */
  'fs.unwatch': { params: { watch: string }; result: null }

  /**
   * Runs a program, without a shell, in a process group of its own, under
   * the id the host gives it, and answers how it ended once it has, after
   * sending what it writes, base64, as events (./cmd/spawn.ts). `env` adds
   * to the helper's environment, and removes a name given `null`.
   */
  spawn: {
    params: { process: string; argv: string[]; cwd: string; env: Record<string, string | null>; stdin: string | null; graceMs: number }
    result: { code: number | null; signal: string | null }
    event: { stream: 'stdout' | 'stderr'; data: string }
  }
  /** Ends a process's group: SIGTERM, then SIGKILL after its grace period. */
  kill: { params: { process: string }; result: null }
  /** Where a program is, on the PATH of `env` or the helper's; a program not there fails with {@link EXECUTABLE_NOT_FOUND}. */
  which: { params: { command: string; env: Record<string, string> | null }; result: string }

  /**
   * Runs a program on a terminal of its own, a pseudo-terminal in the box,
   * under the host's id `terminal` (./cmd/terminal.ts): it sends `started`
   * with the program's pid, then what the terminal writes, base64, and
   * answers how the program ended once it has and the output is sent.
   */
  terminal: {
    params: {
      terminal: string; argv: string[]; cwd: string; env: Record<string, string | null>
      cols: number; rows: number; term: string; graceMs: number
    }
    result: { code: number | null; signal: string | null }
    event: { kind: 'started'; pid: number } | { kind: 'data'; data: string }
  }
  /** Writes text to a terminal's input. */
  'terminal.write': { params: { terminal: string; data: string }; result: null }
  /** Changes a terminal's size, which its foreground program is told. */
  'terminal.resize': { params: { terminal: string; cols: number; rows: number }; result: null }
  /** A terminal's foreground process group, or null when none can be found. */
  'terminal.foreground': { params: { terminal: string }; result: { processGroupId: number } | null }
  /**
   * Whether a terminal is idle: no process of its session is left, or its
   * program, the shell, is the only one, holds the foreground and sleeps,
   * as at its prompt; a terminal not there has ended, so it is idle.
   */
  'terminal.activity': { params: { terminal: string }; result: { idle: boolean } }
  /** Sends a signal to a terminal's foreground process group, and answers its id. */
  'terminal.signal': { params: { terminal: string; signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP' }; result: number }
  /**
   * Ends every process of a terminal's session: SIGHUP and SIGTERM, then
   * SIGKILL after its grace period; answers once none is left.
   */
  'terminal.end': { params: { terminal: string }; result: null }

  /**
   * Makes `modules` the node_modules folder where a tau's code finds its
   * APIs, each linked to its extension's client, as the package `@api/<name>`
   * typed by the tau's declarations, and the packages of the tau's own that
   * it exposes, so that Node, and TypeScript, find them from any file below
   * the folder above `modules` (./cmd/link.ts).
   */
  'apis.link': {
    params: {
      modules: string
      /** Each API: its name, its client's folder, with its index.js, and the folder of the tau's declarations. */
      apis: { name: string; client: string; types: string }[]
      /** Each exposed package of the tau's own: its name, and its folder. */
      packages: { name: string; dir: string }[]
    }
    result: null
  }
}

/**
 * A call a client in the box makes to an extension on the host: the API it
 * implements, the method, and its arguments; and, with `body`, bytes that
 * follow it, such as an archive, in `call-data` messages up to its
 * `call-end`.
 */
export interface Call {
  api: string
  method: string
  args: unknown[]
  body?: true
}

/** Bytes that follow a call, or its answer, base64. */
export interface CallData {
  type: 'call-data'
  id: number
  data: string
}

/** The end of the bytes that follow a call, or its answer; with `error`, cut short. */
export interface CallEnd {
  type: 'call-end'
  id: number
  error?: string
}

export type Method = keyof Methods

/** What a method sends before its result, or never for a method without events. */
export type EventOf<M extends Method> = Methods[M] extends { event: infer E } ? E : never

/**
 * Host to helper: a request, or the answer to a call, whose ids the helper
 * gives, with, when `body` says so, bytes that follow it.
 */
export type HostMessage =
  | { type: 'request'; id: number; method: string; params: unknown }
  | { type: 'call-result'; id: number; value: unknown; body?: true }
  | { type: 'call-error'; id: number; message: string }
  | CallData
  | CallEnd

/** Helper to host: a request's answer, or its event; or a call, the bytes that follow it, or that its caller has gone. */
export type HelperMessage =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'event'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string; code?: string }
  | ({ type: 'call'; id: number } & Call)
  | CallData
  | CallEnd
  | { type: 'call-cancel'; id: number }
