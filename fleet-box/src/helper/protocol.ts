/**
 * The wire between fleet-box and its helper in a session container: one JSON
 * message per line over the stdin and stdout of the `docker exec` that runs
 * the helper. The host sends requests and cancellations; the helper answers
 * each request once and reports each process's output and exit as events.
 *
 * Nothing on this channel is authenticated or encrypted. A container holds one
 * session and everything in it runs as the same root, so a message forged
 * inside the container can only mislead the host about that same container.
 * The host bounds and validates every message it reads, and never acts on the
 * host's filesystem on the helper's word.
 *
 * Shared by the host and the helper, so it holds only types and constants.
 * @module fleet-box/helper/protocol
 */

/** Wire version; the host refuses a helper that answers with another. */
export const PROTOCOL_VERSION = 1

/**
 * Longest message line the helper sends, newline excluded. A request whose
 * answer would be longer gets an `FS_TOO_LARGE` error instead, and the host
 * drops a helper that sends a longer line anyway.
 */
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024

/**
 * Longest text, in UTF-16 code units, that a write or an edit may replace or
 * produce. Its answer carries the text before and after, and JSON spends at
 * most six bytes on one unit, so the answer fits in a message; a larger one
 * is refused before the file changes.
 */
export const MAX_WRITE_TEXT = 10 * 1024 * 1024

/** Raw output bytes carried by one `output` event. */
export const OUTPUT_CHUNK_BYTES = 64 * 1024

/** Error code of an executable lookup that found nothing. */
export const EXECUTABLE_NOT_FOUND = 'EXECUTABLE_NOT_FOUND'

/** Host to helper. */
export type HostMessage =
  | { type: 'request'; id: number; method: string; params: Record<string, unknown> }
  /** Stop working on a request; its answer may still arrive. */
  | { type: 'cancel'; id: number }

/** A failure as the helper reports it; `code` is a dsh-fs error code or {@link EXECUTABLE_NOT_FOUND}. */
export interface WireError {
  name: string
  message: string
  code?: string
}

/** Helper to host. */
export type HelperMessage =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; error: WireError }
  /** Base64 bytes a process wrote, in order. */
  | { type: 'output'; process: string; stream: 'stdout' | 'stderr'; data: string }
  /** The process exited and its output has ended or stopped being read; no `output` follows. */
  | { type: 'exit'; process: string; exitCode: number | null; signal: string | null }

/** Parameters of `process.spawn`. */
export interface SpawnParams {
  /** Id the host chose; the helper's events name it. */
  process: string
  argv: string[]
  cwd: string
  /** Entries layered on the helper's environment; null removes one. */
  env: Record<string, string | null>
  /** Bytes written to stdin before it closes; null leaves stdin on /dev/null. */
  stdin: string | null
  /** Milliseconds between SIGTERM and SIGKILL, and for draining output after exit. */
  graceMs: number
}
