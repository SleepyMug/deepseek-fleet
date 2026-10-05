/**
 * The host's side of the helper's processes
 * (fleet-box-runtime/helper/cmd/spawn): the checks of its answers and events,
 * which the helper connection registers (../helper.ts).
 * @module fleet-core/box/cmd/spawn
 */

import type { EventOf, Methods } from 'fleet-box-runtime/helper/protocol'

export function isSpawnResult(value: unknown): value is Methods['spawn']['result'] {
  if (typeof value !== 'object' || value === null) return false
  const { code, signal } = value as Record<string, unknown>
  return (code === null || Number.isSafeInteger(code)) && (signal === null || typeof signal === 'string')
}

export function isSpawnEvent(value: unknown): value is EventOf<'spawn'> {
  if (typeof value !== 'object' || value === null) return false
  const { stream, data } = value as Record<string, unknown>
  return (stream === 'stdout' || stream === 'stderr') && typeof data === 'string'
}

export function isNull(value: unknown): value is null {
  return value === null
}

export function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/')
}
