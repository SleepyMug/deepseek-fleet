/**
 * The wire between the host and the helper in a box: one JSON message per
 * line over the stdin and stdout of the `docker exec` that runs the helper.
 * The host sends requests; the helper answers each exactly once, in any
 * order, and exits when its stdin ends. Shared by both ends, so it holds
 * only types and constants.
 * @module fleet-image/helper/protocol
 */

/** Wire version; the host refuses a helper that answers `hello` with another. */
export const PROTOCOL_VERSION = 1

/** Each method's params and result. */
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
}

export type Method = keyof Methods

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
  | { type: 'error'; id: number; message: string }
