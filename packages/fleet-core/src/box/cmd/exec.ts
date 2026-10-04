/**
 * The host's side of the helper's `exec` (fleet-image/helper/cmd/exec): the
 * check of its answer, which the helper connection registers (../helper.ts),
 * and `exec`, which runs a program in a started box and fails unless it exits
 * with 0.
 * @module fleet-core/box/cmd/exec
 */

import type { Methods } from 'fleet-image/helper/protocol'
import type { Box } from '../box.ts'

type Result = Methods['exec']['result']

/** Whether a value is what the helper answers `exec` with. */
export function isExecResult(value: unknown): value is Result {
  if (typeof value !== 'object' || value === null) return false
  const { code, signal, stdout, stderr } = value as Record<string, unknown>
  return (code === null || Number.isSafeInteger(code))
    && (signal === null || typeof signal === 'string')
    && typeof stdout === 'string' && typeof stderr === 'string'
}

/**
 * Run a program in a started box, without a shell.
 * @param argv - the program, then its arguments.
 * @returns what it wrote to stdout; an exit other than 0 fails, with what it wrote to stderr.
 */
export async function exec(box: Pick<Box, 'container' | 'request'>, argv: string[]): Promise<string> {
  const { code, signal, stdout, stderr } = await box.request('exec', { argv })
  if (code !== 0) {
    const ended = signal === null ? `exited with ${String(code)}` : `was killed by ${signal}`
    throw new Error(`fleet: ${argv[0]} in box ${box.container} ${ended}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
  }
  return stdout
}
