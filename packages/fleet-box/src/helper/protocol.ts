/**
 * The wire between fleet-box and its helper in a session container: one JSON
 * message per line over the stdin and stdout of the `docker exec` that runs
 * the helper. The host sends requests and cancellations; the helper answers
 * each request once and reports each process's output and exit as events.
 * The other way round, the helper relays the service calls that programs in
 * the container make on its service socket ({@link SERVICE_SOCKET}), and the
 * host answers each once.
 *
 * Nothing on this channel is authenticated or encrypted. A container holds one
 * session and everything in it runs as the same root, so a message forged
 * inside the container can only mislead the host about that same container.
 * The host bounds and validates every message it reads, and never acts on the
 * host's filesystem on the helper's word. A service call is the one thing the
 * host does at the container's request: it runs a provider plugin's code for
 * the session whose container the call came from, which the host knows from
 * the connection and never takes from the message, and only a call that
 * session's spec declares, with arguments the provider's manifest accepts. The
 * host bounds the calls in flight, and each call's size both ways.
 *
 * Shared by the host and the helper, so it holds only types and constants.
 * @module fleet-box/helper/protocol
 */

/** Wire version; the host refuses a helper that answers with another. */
export const PROTOCOL_VERSION = 3

/**
 * Where the helper serves tau's service protocol (@sleepymug/tau's SPEC.md)
 * in the container: one call per connection, one JSON line each way.
 */
export const SERVICE_SOCKET = '/run/fleet-box/tau.sock'

/** Longest service call, or answer to one, in bytes of JSON, either way. */
export const MAX_CALL_BYTES = 16 * 1024 * 1024

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

/**
 * Environment variable that marks a terminal's processes. The host starts a
 * terminal's shell with `docker exec`, outside the helper, and sets it to the
 * terminal's id; everything the shell starts inherits it, so the helper finds
 * the terminal's processes by it.
 */
export const TERMINAL_MARKER = 'FLEET_BOX_TERMINAL'

/** What `terminal.state` reports about one terminal. */
export interface TerminalState {
  /** Whether the terminal's shell still runs. */
  shell: boolean
  /** The terminal's processes, the shell included (./terminals.ts). */
  members: number
  /**
   * The shell waits at its prompt, as far as the process table tells: it is
   * the terminal's only process, holds the foreground of its terminal, and
   * sleeps. A loop of shell builtins that sleeps looks the same.
   */
  prompt: boolean
}

/** Host to helper. */
export type HostMessage =
  | { type: 'request'; id: number; method: string; params: Record<string, unknown> }
  /** Stop working on a request; its answer may still arrive. */
  | { type: 'cancel'; id: number }
  /** The answer to a service call: its result, JSON. */
  | { type: 'call-result'; call: number; result: unknown }
  /** A service call failed; the message says why. */
  | { type: 'call-error'; call: number; message: string }

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
  /** A program in the container calls a service; `call` is the helper's id for it. */
  | { type: 'call'; call: number; service: string; function: string; args: unknown[] }
  /** The program went away before the answer; the host should stop the call. */
  | { type: 'call-cancel'; call: number }

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
