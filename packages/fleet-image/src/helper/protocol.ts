/**
 * The wire between the host and the helper in a box: one JSON message per
 * line over the stdin and stdout of the `docker exec` that runs the helper.
 * The host sends requests; the helper answers each exactly once, in any
 * order, and may send events for a request before it answers it. The helper
 * exits when its stdin ends, and ends the processes it started first. Shared
 * by both ends, so it holds only types and constants.
 * @module fleet-image/helper/protocol
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
  /** The handshake. */
  hello: { params: Record<string, never>; result: { protocol: number } }
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
}

export type Method = keyof Methods

/** What a method sends before its result, or never for a method without events. */
export type EventOf<M extends Method> = Methods[M] extends { event: infer E } ? E : never

/** Host to helper. */
export interface HostMessage {
  type: 'request'
  id: number
  method: string
  params: unknown
}

/** Helper to host. */
export type HelperMessage =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'event'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string; code?: string }
