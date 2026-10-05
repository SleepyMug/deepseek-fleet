/**
 * The host's side of the helper's `ts.execute`
 * (fleet-box-runtime/helper/cmd/ts): the check of its answer, which the
 * helper connection registers (../helper.ts).
 * @module fleet-core/box/cmd/ts
 */

import type { TsOutcome } from 'fleet-box-runtime/helper/protocol'

/** Whether a value is what the helper answers `ts.execute` with. */
export function isTsOutcome(value: unknown): value is TsOutcome {
  if (typeof value !== 'object' || value === null) return false
  const { ok, stdout, stderr } = value as Record<string, unknown>
  if (typeof stdout !== 'string' || typeof stderr !== 'string') return false
  if (ok === true) {
    const { durationMs } = value as Record<string, unknown>
    return Object.hasOwn(value, 'value') && typeof durationMs === 'number'
  }
  if (ok !== false) return false
  const { error } = value as Record<string, unknown>
  if (typeof error !== 'object' || error === null) return false
  const { name, message, stack, diagnostics } = error as Record<string, unknown>
  return typeof name === 'string' && typeof message === 'string' && (stack === undefined || typeof stack === 'string')
    && (diagnostics === undefined || (Array.isArray(diagnostics) && diagnostics.every(isDiagnostic)))
}

function isDiagnostic(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { category, code, message, file, line, column } = value as Record<string, unknown>
  return typeof category === 'string' && Number.isSafeInteger(code) && typeof message === 'string'
    && (file === undefined || typeof file === 'string') && (line === undefined || Number.isSafeInteger(line))
    && (column === undefined || Number.isSafeInteger(column))
}
