/**
 * The host's side of the helper's file system (fleet-image/helper/cmd/fs):
 * the checks of its answers, which the helper connection registers
 * (../helper.ts). Whatever runs in the box can answer in the helper's name,
 * so a target must name an absolute path, and every field must be what dsh's
 * file system types say, before it reaches dsh.
 * @module fleet-core/box/cmd/fs
 */

import type { DirEntry, EditOutcome, EventOf, Info, PathInfo, Target, WriteOutcome } from 'fleet-image/helper/protocol'

export function isTarget(value: unknown): value is Target {
  return isRecord(value) && isAbsolutePath(value.targetKey) && typeof value.displayPath === 'string'
}

export function isInfoOrNull(value: unknown): value is Info | null {
  return value === null || isInfo(value, ['file', 'directory', 'other'])
}

export function isPathInfoOrNull(value: unknown): value is PathInfo | null {
  return value === null || isInfo(value, ['file', 'directory', 'symlink', 'other'])
}

export function isDirEntries(value: unknown): value is DirEntry[] {
  return Array.isArray(value) && value.every(entry => isRecord(entry)
    && typeof entry.name === 'string'
    && ['file', 'directory', 'other'].includes(entry.type as string)
    && isTarget(entry.target)
    && (entry.version === undefined || typeof entry.version === 'string')
    && isSize(entry.size))
}

export function isWriteOutcome(value: unknown): value is WriteOutcome {
  return isRecord(value)
    && (value.operation === 'create' || value.operation === 'update')
    && typeof value.version === 'string'
    && (value.before === null || typeof value.before === 'string')
    && typeof value.after === 'string'
}

export function isEditOutcome(value: unknown): value is EditOutcome {
  return isRecord(value) && typeof value.version === 'string' && typeof value.before === 'string' && typeof value.after === 'string'
}

export function isWatchEvent(value: unknown): value is EventOf<'fs.watch'> {
  return isRecord(value) && (value.error === null || typeof value.error === 'string')
}

/** Text, or base64 bytes. */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isInfo(value: unknown, types: string[]): boolean {
  return isRecord(value) && typeof value.version === 'string' && types.includes(value.type as string) && isSize(value.size)
}

function isSize(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0)
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
