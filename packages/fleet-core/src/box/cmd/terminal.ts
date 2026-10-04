/**
 * The host's side of the helper's terminals (fleet-image/helper/cmd/terminal):
 * the checks of their answers and events, which the helper connection
 * registers (../helper.ts).
 * @module fleet-core/box/cmd/terminal
 */

import type { EventOf, Methods } from 'fleet-image/helper/protocol'

export function isTerminalEvent(value: unknown): value is EventOf<'terminal'> {
  if (typeof value !== 'object' || value === null) return false
  const { kind, pid, data } = value as Record<string, unknown>
  return (kind === 'started' && Number.isSafeInteger(pid) && (pid as number) > 0) || (kind === 'data' && typeof data === 'string')
}

export function isForeground(value: unknown): value is Methods['terminal.foreground']['result'] {
  if (value === null) return true
  if (typeof value !== 'object') return false
  const { processGroupId } = value as Record<string, unknown>
  return Number.isSafeInteger(processGroupId) && (processGroupId as number) > 0
}

export function isGroupId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
