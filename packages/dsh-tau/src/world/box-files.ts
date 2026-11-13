/**
 * A box's files as dsh's file system has files (`@deepseek-ai/dsh-fs`), over
 * the box's API (`fleet.box.v1.Box`), as dsh's local file system
 * (`@deepseek-ai/dsh-fs-local`) has them on the host: a target's key is
 * where its path leads, every symlink followed, and its display path the
 * path as named; its version the box's; text is UTF-8, a NUL in its first
 * 8 KiB making it binary; a write replaces a file whole, through its
 * symlinks, keeping its permission bits, its guard checked as the box puts
 * the file in place, so a file changed since it was read is not
 * overwritten; and an edit replaces literal text, its line endings kept.
 * Every path here is the box's own, absolute; the failures are `FsError`s.
 * @module @sleepymug/dsh-tau/world/box-files
 */

import { posix } from 'node:path'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { type FileInfo, FileType, WriteFileRequestSchema } from '@sleepymug/fleet-protocol/box'
import type { BoxApi } from '../tau/ports.ts'
import { streamOf } from '../util/stream.ts'

/** How much of a file's start is looked through for a NUL, which makes it binary. */
const BINARY_SAMPLE_BYTES = 8192

/** The largest file whose text before a write is kept, for a diff of it. */
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** Where a path leads in the box, relative to `cwd`: its key, and the path as named. */
export async function resolveIn(api: BoxApi, path: string, cwd: string): Promise<FsTarget> {
  if (path.trim() === '') throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = named(path, cwd)
  const { path: real } = await ask(`resolve "${displayPath}"`, () => api.resolve({ path: displayPath }))
  return { targetKey: FsTargetKey(real), displayPath }
}

/** What is at a target, symlinks followed; nothing if nothing is. */
export async function statIn(api: BoxApi, target: FsTarget): Promise<FsInfo | undefined> {
  const info = await infoOf(api, String(target.targetKey), true, `stat "${target.displayPath}"`)
  return info === undefined ? undefined : { version: FsVersion(info.version), type: kindOf(info), ...sizeOf(info) }
}

/** What is at a path, its last symlink not followed; nothing if nothing is. */
export async function lstatIn(api: BoxApi, path: string, cwd: string): Promise<FsPathInfo | undefined> {
  if (path.trim() === '') throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const at = named(path, cwd)
  const info = await infoOf(api, at, false, `lstat "${at}"`)
  if (info === undefined) return undefined
  const type = info.type === FileType.SYMLINK ? 'symlink' : kindOf(info)
  return { version: FsVersion(info.version), type, ...sizeOf(info) }
}

/** A regular file's text, whole, as it is. */
export async function readTextIn(api: BoxApi, target: FsTarget): Promise<string> {
  const raw = await bytesOf(api, target, 'read')
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  return decode(raw, 'read', target.displayPath)
}

/** A regular file's bytes, whole, at most `maxBytes` of them. */
export async function readBytesIn(api: BoxApi, target: FsTarget, maxBytes: number): Promise<Uint8Array> {
  const info = await regular(api, target, 'read')
  if (Number(info.size) > maxBytes) throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
  const bytes = await read(api, target, 0, maxBytes + 1)
  if (bytes.length > maxBytes) throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
  return bytes
}

/** The bytes of a regular file at `[offset, offset + length)`; empty past its end. */
export async function readRangeIn(api: BoxApi, target: FsTarget, { offset, length }: { offset: number; length: number }): Promise<Uint8Array> {
  await regular(api, target, 'read')
  if (length === 0) return new Uint8Array(0)
  return await read(api, target, offset, length)
}

/** What a folder holds, by name, each with its target. */
export async function listDirIn(api: BoxApi, target: FsTarget): Promise<FsDirEntry[]> {
  const folder = String(target.targetKey)
  const { entries } = await ask(`list "${target.displayPath}"`, () => api.listDir({ path: folder }))
  const listed: FsDirEntry[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const { name } = entry
    const displayPath = posix.join(target.displayPath, name)
    // A child of a folder whose path is where it leads leads where it is, unless it is a symlink.
    const linked = entry.info?.type === FileType.SYMLINK
    const child = linked ? await resolveIn(api, posix.join(folder, name), '/') : { targetKey: FsTargetKey(posix.join(folder, name)) }
    const info = linked ? await infoOf(api, String(child.targetKey), true, `list "${displayPath}"`) : entry.info
    listed.push({
      name,
      type: info === undefined ? 'other' : kindOf(info),
      target: { targetKey: child.targetKey, displayPath },
      ...info === undefined ? {} : { version: FsVersion(info.version) },
      ...info !== undefined && kindOf(info) === 'file' ? { size: Number(info.size) } : {},
    })
  }
  return listed
}

/** Write a file's text whole, as `expected` guards it, and give back its version, and its text before, for a diff. */
export async function writeTextIn(api: BoxApi, target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
  const { displayPath } = target
  const existing = await infoOf(api, String(target.targetKey), true, `write "${displayPath}"`)
  if (existing !== undefined && kindOf(existing) !== 'file') throw new FsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  if (expected?.kind === 'replaceIfVersion') {
    if (existing === undefined) throw new FsError(`cannot write "${displayPath}": file no longer exists`, 'FS_STALE_VERSION')
    if (existing.version !== expected.version) throw new FsError(`cannot write "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
  } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
    throw new FsError(`cannot overwrite existing "${displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
  }
  const before = existing !== undefined && Buffer.byteLength(content, 'utf8') < DIFF_BASIS_MAX_BYTES ? await diffBasis(api, target, existing) : null
  const guard = expected?.kind === 'createIfAbsent' ? { exclusive: true } : expected?.kind === 'replaceIfVersion' ? { ifVersion: expected.version } : {}
  const version = await write(api, target, content, guard)
  return { operation: existing === undefined ? 'create' : 'update', version, before, after: normalize(content) }
}

/** Replace literal text in a file, as `expected` guards it, its line endings kept. */
export async function editTextIn(api: BoxApi, target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }): Promise<FsEditOutcome> {
  const { displayPath } = target
  const existing = await infoOf(api, String(target.targetKey), true, `edit "${displayPath}"`)
  if (existing === undefined) throw new FsError(`cannot edit "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
  if (kindOf(existing) !== 'file') throw new FsError(`cannot edit "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  if (expected !== undefined && existing.version !== expected.version) throw new FsError(`cannot edit "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
  const raw = await read(api, target, 0, undefined, 'edit')
  if (raw.includes(0)) throw new FsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
  const text = decode(raw, 'edit', displayPath)
  const original = normalize(text)
  const edited = applyLiteralEdit(original, edit, displayPath)
  // As it was read, or not at all: a file changed meanwhile fails as stale.
  const version = await write(api, target, lineEndingsOf(text) === 'CRLF' ? normalize(edited).split('\n').join('\r\n') : edited, { ifVersion: existing.version })
  return { version, before: original, after: edited }
}

/** A path, relative to `cwd`, absolute, `..` kept as named where it is, so that the box takes it from where a symlink leads. */
function named(path: string, cwd: string): string {
  const raw = posix.isAbsolute(path) ? path : `${cwd}/${path}`
  return /(?:^|\/)\.\.(?:\/|$)/u.test(raw) ? raw : posix.resolve(cwd, path)
}

async function infoOf(api: BoxApi, path: string, follow: boolean, what: string): Promise<FileInfo | undefined> {
  return (await ask(what, () => api.stat({ path, follow }))).info
}

function kindOf(info: FileInfo): 'file' | 'directory' | 'other' {
  return info.type === FileType.FILE ? 'file' : info.type === FileType.DIRECTORY ? 'directory' : 'other'
}

function sizeOf(info: FileInfo): { size?: number } {
  return info.type === FileType.FILE ? { size: Number(info.size) } : {}
}

/** What is at a target, which must be a regular file. */
async function regular(api: BoxApi, target: FsTarget, verb: string): Promise<FileInfo> {
  const info = await infoOf(api, String(target.targetKey), true, `${verb} "${target.displayPath}"`)
  if (info === undefined) throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (kindOf(info) !== 'file') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

async function bytesOf(api: BoxApi, target: FsTarget, verb: string): Promise<Buffer> {
  await regular(api, target, verb)
  return await read(api, target, 0, undefined, verb)
}

async function read(api: BoxApi, target: FsTarget, offset: number, length: number | undefined, verb = 'read'): Promise<Buffer> {
  return await ask(`${verb} "${target.displayPath}"`, async () => {
    const chunks: Uint8Array[] = []
    for await (const { chunk } of api.readFile({ path: String(target.targetKey), offset: BigInt(offset), ...length === undefined ? {} : { length: BigInt(length) } })) chunks.push(chunk)
    return Buffer.concat(chunks)
  })
}

/** Write a file whole, `guard` as the box checks it, and give back its version. */
async function write(api: BoxApi, target: FsTarget, content: string, guard: { exclusive?: boolean; ifVersion?: string }): Promise<FsVersion> {
  const { displayPath } = target
  try {
    const { version } = await api.writeFile(streamOf(
      create(WriteFileRequestSchema, { request: { case: 'start', value: { path: String(target.targetKey), parents: true, ...guard } } }),
      create(WriteFileRequestSchema, { request: { case: 'chunk', value: Buffer.from(content, 'utf8') } }),
    ))
    return FsVersion(version)
  } catch (error) {
    const code = ConnectError.from(error).code
    if (code === Code.AlreadyExists) throw new FsError(`cannot overwrite existing "${displayPath}" without reading it first`, 'FS_NOT_OBSERVED', { cause: error })
    if (code === Code.Aborted) throw new FsError(`cannot write "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION', { cause: error })
    throw fsError(`write "${displayPath}"`, error)
  }
}

/** A file's text before a write, for a diff of it; null for one too large, binary, or no UTF-8. */
async function diffBasis(api: BoxApi, target: FsTarget, info: FileInfo): Promise<string | null> {
  if (Number(info.size) >= DIFF_BASIS_MAX_BYTES) return null
  try {
    const raw = await read(api, target, 0, DIFF_BASIS_MAX_BYTES)
    if (raw.length >= DIFF_BASIS_MAX_BYTES || raw.includes(0)) return null
    return normalize(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    return null
  }
}

function decode(raw: Uint8Array, verb: string, displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
  }
}

function normalize(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

/** A text's line endings, as the most of its first 4 KiB's are. */
function lineEndingsOf(text: string): 'LF' | 'CRLF' {
  const sample = text.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  return crlf > sample.split('\n').length - 1 - crlf ? 'CRLF' : 'LF'
}

function applyLiteralEdit(content: string, { oldString, newString, replaceAll }: FsEditRequest, displayPath: string): string {
  const old = normalize(oldString)
  if (old.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  const replacements = content.split(old).length - 1
  if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return content.split(old).join(normalize(newString))
}

/** A call of the box's, its failure an `FsError`. */
async function ask<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw fsError(what, error)
  }
}

const CODES: Partial<Record<Code, FsErrorCode>> = {
  [Code.NotFound]: 'FS_NOT_FOUND',
  [Code.PermissionDenied]: 'FS_PERMISSION_DENIED',
  [Code.Aborted]: 'FS_STALE_VERSION',
  [Code.Canceled]: 'FS_ABORTED',
}

/** A box's failure as an `FsError`: one already is; a call's by its code, or `FS_IO_ERROR`. */
export function fsError(what: string, error: unknown): FsError {
  if (error instanceof FsError) return error
  const failure = ConnectError.from(error)
  const message = failure.rawMessage
  if (failure.code === Code.FailedPrecondition && /ENOTDIR|not a directory/iu.test(message)) {
    return new FsError(`cannot ${what}: a parent path segment is not a directory`, 'FS_NOT_DIRECTORY', { cause: error })
  }
  return new FsError(`cannot ${what}: ${message}`, CODES[failure.code] ?? 'FS_IO_ERROR', { cause: error })
}
