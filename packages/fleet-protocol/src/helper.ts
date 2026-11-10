/**
 * The wire between the fleet host and the helper in a box: one JSON message
 * per line over the stdin and stdout of the `docker exec` that runs the
 * helper. The host sends requests; the helper answers each exactly once, in
 * any order, and may send events for a request before it answers it. The
 * connections to the box's services cross the box's channel, not this wire
 * (./channel.ts). The helper exits when its stdin
 * ends, and ends the processes it started first. Shared by both ends, so it
 * holds only types and constants. The methods but `hello`, `echo` and
 * `services.*` are the box's API, which a harness reaches through the fleet
 * host (./fleet.ts).
 * @module @sleepymug/fleet-protocol/helper
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
   * code or the signal that killed it, and all it wrote (fleet-box's helper/cmd/exec.ts).
   */
  exec: {
    params: { argv: string[] }
    result: { code: number | null; signal: string | null; stdout: string; stderr: string }
  }

  // The box's files, as dsh's file system names them, served in the box by dsh's own local one (fleet-box's helper/cmd/fs.ts).
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
   * sending what it writes, base64, as events (fleet-box's helper/cmd/spawn.ts). `env` adds
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
   * under the host's id `terminal` (fleet-box's helper/cmd/terminal.ts): it sends `started`
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

  /** The digests of the services' packages the box holds, by name, each copied in as `<name>@<digest>` (layout.ts). */
  'services.installed': { params: Record<string, never>; result: Record<string, string[]> }
  /**
   * Makes the box's services these, each of whose packages it holds: a link
   * to the package in use by its name, its commands linked on the PATH, its
   * socket, which the helper listens on and relays, and its environment, for
   * each process the helper starts from then on; a service not listed has
   * none of them, and an older package of one listed is removed.
   */
  'services.sync': { params: { services: ServiceInBox[] }; result: null }
}

/** A service, as a box has it. */
export interface ServiceInBox {
  name: string
  /** The digest of its package, which the box holds as `<name>@<digest>`. */
  digest: string
  /** Its commands, each by its name, the path of its program in the package. */
  bins: Record<string, string>
  /** What it adds to the environment of every process the helper starts. */
  env: Record<string, string>
}

export type Method = keyof Methods

/** What a method sends before its result, or never for a method without events. */
export type EventOf<M extends Method> = Methods[M] extends { event: infer E } ? E : never

/** Host to helper: a request. */
export type HostMessage = { type: 'request'; id: number; method: string; params: unknown }

/** Helper to host: a request's answer, or its event. */
export type HelperMessage =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'event'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string; code?: string }
