/**
 * The box's files, as `Box` serves them: what is at a path, and its
 * version, where a path leads, watches, what a folder holds, a file read
 * and written as a stream of its bytes, folders made, and things removed
 * and moved; and trees, a folder's contents or a file, as tar archives, in
 * and out (fleet-pack). Every path is absolute; a failure is reported by
 * its errno (../errors.ts), and a write whose version is not the file's as
 * aborted, the code of a conflict.
 * @module @sleepymug/fleet-box/helper/box/files
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, watch as watchPath, type BigIntStats } from 'node:fs'
import { chmod, link, lstat, mkdir, readdir, readlink, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import {
  type FileInfo, FileInfoSchema, FileType, type GetRequest, type ListDirRequest, type MakeDirRequest, type PutRequest, type ReadFileRequest,
  type RemoveRequest, type RenameRequest, type ResolveRequest, type StatRequest, type WatchRequest, type WatchResponse, WatchResponseSchema, type WriteFileRequest,
  type WriteFileResponseSchema,
} from '@sleepymug/fleet-protocol/box'
import { packTree, pathEntry, unpackTree, writeTar } from '@sleepymug/fleet-pack'
import { invalid, systemError } from '../errors.ts'

export async function statOf({ path, follow }: StatRequest): Promise<{ info?: FileInfo }> {
  const at = absolute(path)
  try {
    return { info: await infoOf(at, follow ? await stat(at, { bigint: true }) : await lstat(at, { bigint: true })) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw systemError(error, `stat ${at}`)
  }
}

/** Where a path leads, every symlink in it followed; for a path to nothing, its nearest folder that is there, followed, and the rest after it. */
export async function resolvePath({ path }: ResolveRequest): Promise<{ path: string }> {
  const at = absolute(path)
  try {
    return { path: await resolved(at) }
  } catch (error) {
    throw systemError(error, `resolve ${at}`)
  }
}

/**
 * Watch a file or a folder until the call ends: ready first, then a change
 * each time what is at the path, or what the folder holds, may have
 * changed. A file is watched through its folder, so that one replaced, as
 * a write replaces it, is still watched.
 */
export async function* watch({ path }: WatchRequest, signal: AbortSignal): AsyncGenerator<WatchResponse> {
  const at = absolute(path)
  let folder: boolean
  try {
    folder = (await stat(at)).isDirectory()
  } catch (error) {
    throw systemError(error, `watch ${at}`)
  }
  const root = folder ? at : dirname(at)
  const name = basename(at)
  const changes: (Error | undefined)[] = []
  let wake: (() => void) | undefined
  const push = (change: Error | undefined): void => {
    changes.push(change)
    wake?.()
  }
  let watcher
  try {
    watcher = watchPath(root, { signal }, (_event, changed) => { if (folder || changed === null || changed === name) push(undefined) })
  } catch (error) {
    throw systemError(error, `watch ${at}`)
  }
  watcher.on('error', (error) => { if (!signal.aborted) push(error) })
  const ended = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  try {
    yield create(WatchResponseSchema, { event: { case: 'ready', value: {} } })
    while (!signal.aborted) {
      if (changes.length === 0) {
        await Promise.race([new Promise<void>((resolve) => { wake = resolve }), ended])
        wake = undefined
        continue
      }
      const change = changes.shift()
      if (change !== undefined) throw systemError(change, `watch ${at}`)
      // Changes that came together are said once.
      while (changes.length > 0 && changes[0] === undefined) changes.shift()
      yield create(WatchResponseSchema, { event: { case: 'changed', value: {} } })
    }
  } finally {
    watcher.close()
  }
}

export async function listDir({ path }: ListDirRequest) {
  const at = absolute(path)
  try {
    const names = (await readdir(at)).sort()
    const entries = await Promise.all(names.map(async (name) => {
      const child = `${at === '/' ? '' : at}/${name}`
      const info = await lstat(child, { bigint: true }).then(found => infoOf(child, found), () => undefined)
      return info === undefined ? undefined : { name, info }
    }))
    return { entries: entries.filter(entry => entry !== undefined) }
  } catch (error) {
    throw systemError(error, `list ${at}`)
  }
}

export async function* readFile({ path, offset, length }: ReadFileRequest): AsyncGenerator<{ chunk: Uint8Array }> {
  const at = absolute(path)
  const start = Number(offset)
  const end = length === undefined ? undefined : start + Number(length) - 1
  if (end !== undefined && end < start) return
  let stream: Readable
  try {
    if ((await stat(at)).isDirectory()) throw Object.assign(new Error('it is a folder'), { code: 'EISDIR' })
    stream = createReadStream(at, { start, end })
  } catch (error) {
    throw systemError(error, `read ${at}`)
  }
  try {
    for await (const chunk of stream) yield { chunk: chunk as Buffer }
  } catch (error) {
    throw systemError(error, `read ${at}`)
  }
}

/**
 * Write a file from the requests' bytes. One replaced is written beside it
 * first and then put in its place, whole or not at all, through the
 * symlinks that lead to it, keeping its permission bits unless the write
 * gives others; one made exclusively is put in place only if nothing is
 * there. A version to wait on is checked as the file is put in place, one
 * write to a file at a time.
 */
export async function writeFile(requests: AsyncIterable<WriteFileRequest>): Promise<MessageInitShape<typeof WriteFileResponseSchema>> {
  const iterator = requests[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done === true || first.value.request.case !== 'start') throw invalid('a write starts with which file')
  const { path, mode, parents, exclusive, append, ifVersion } = first.value.request.value
  const chunks = async function* () {
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      if (next.value.request.case === 'chunk') yield next.value.request.value
      else throw invalid('a write starts once')
    }
  }
  let at = absolute(path)
  let temp: string | undefined
  try {
    if (parents) await mkdir(dirname(at), { recursive: true })
    at = await resolved(at)
    if (append) {
      return await locked(at, async () => {
        await checkVersion(at, ifVersion)
        await pipeline(Readable.from(chunks()), createWriteStream(at, { flags: exclusive ? 'ax' : 'a', mode: mode ?? 0o644 }))
        return written(at)
      })
    }
    temp = join(dirname(at), `.${basename(at)}.${randomUUID()}.fleet`)
    await pipeline(Readable.from(chunks()), createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
    const staged = temp
    return await locked(at, async () => {
      const existing = await checkVersion(at, ifVersion)
      await chmod(staged, mode ?? (existing?.isFile() === true ? Number(existing.mode) & 0o7777 : 0o644))
      if (exclusive) await link(staged, at)
      else await rename(staged, at)
      return written(at)
    })
  } catch (error) {
    throw systemError(error, `write ${at}`)
  } finally {
    if (temp !== undefined) await rm(temp, { force: true })
  }
}

/** What is at `at`, which must be at `version`, if one is given. */
async function checkVersion(at: string, version: string | undefined): Promise<BigIntStats | undefined> {
  const existing = await lstat(at, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (version !== undefined && (existing === undefined || versionOf(existing) !== version)) {
    throw new ConnectError(`${at} is not at version ${version}: ${existing === undefined ? 'nothing is there' : 'it changed'}`, Code.Aborted)
  }
  return existing
}

async function written(at: string): Promise<MessageInitShape<typeof WriteFileResponseSchema>> {
  const info = await stat(at, { bigint: true })
  return { size: info.size, version: versionOf(info) }
}

/** The writes to each file, one after another. */
const writing = new Map<string, Promise<unknown>>()

async function locked<T>(at: string, op: () => Promise<T>): Promise<T> {
  const run = (writing.get(at) ?? Promise.resolve()).then(op, op)
  const tail = run.catch(() => {})
  writing.set(at, tail)
  try {
    return await run
  } finally {
    if (writing.get(at) === tail) writing.delete(at)
  }
}

export async function makeDir({ path, parents }: MakeDirRequest): Promise<object> {
  const at = absolute(path)
  try {
    await mkdir(at, { recursive: parents })
    return {}
  } catch (error) {
    throw systemError(error, `make ${at}`)
  }
}

export async function remove({ path, recursive }: RemoveRequest): Promise<{ removed: boolean }> {
  const at = absolute(path)
  if (at === '/') throw invalid('the box\'s root is not removed')
  try {
    const info = await lstat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (info === undefined) return { removed: false }
    if (info.isDirectory() && !recursive) await rmdir(at)
    else await rm(at, { recursive, force: true })
    return { removed: true }
  } catch (error) {
    throw systemError(error, `remove ${at}`)
  }
}

export async function move({ from, to }: RenameRequest): Promise<object> {
  const [source, target] = [absolute(from), absolute(to)]
  try {
    await rename(source, target)
    return {}
  } catch (error) {
    throw systemError(error, `move ${source} to ${target}`)
  }
}

/** Unpack the archive the requests carry into the folder the first names, through the box's own symlinks. */
export async function put(requests: AsyncIterable<PutRequest>): Promise<object> {
  const iterator = requests[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done === true || first.value.request.case !== 'path') throw invalid('a put starts with the folder it unpacks into')
  const at = absolute(first.value.request.value)
  const chunks = async function* () {
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      if (next.value.request.case === 'chunk') yield next.value.request.value
      else throw invalid('a put names its folder once')
    }
  }
  try {
    await unpackTree(chunks(), at, { what: `the archive put in ${at}`, followLinks: true })
    return {}
  } catch (error) {
    throw systemError(error, `put into ${at}`)
  }
}

/** A folder's contents, or a file or a symlink under its own name, as an archive. */
export async function* get({ path }: GetRequest): AsyncGenerator<{ chunk: Uint8Array }> {
  const at = absolute(path)
  let archive: AsyncIterable<Uint8Array>
  try {
    const info = await lstat(at)
    if (info.isDirectory()) archive = packTree(at)
    else {
      const entry = await pathEntry(at, basename(at))
      if (entry === undefined) throw invalid(`${at} is neither a file, a folder nor a symlink`)
      archive = writeTar([entry])
    }
  } catch (error) {
    throw systemError(error, `get ${at}`)
  }
  try {
    for await (const chunk of archive) yield { chunk }
  } catch (error) {
    throw systemError(error, `get ${at}`)
  }
}

async function infoOf(path: string, info: BigIntStats): Promise<FileInfo> {
  const type = info.isFile() ? FileType.FILE : info.isDirectory() ? FileType.DIRECTORY : info.isSymbolicLink() ? FileType.SYMLINK : FileType.OTHER
  return create(FileInfoSchema, {
    type,
    size: info.size,
    mode: Number(info.mode) & 0o7777,
    modified: timestampFromDate(info.mtime),
    target: type === FileType.SYMLINK ? await readlink(path) : '',
    version: versionOf(info),
  })
}

/** What is at a path, as a token that changes whenever it does: which file it is, its size, and when it and its inode last changed. */
function versionOf(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/**
 * `at` with every symlink in it followed, `..` after a symlink taken from
 * where the symlink leads; for a path to nothing, its nearest folder that is
 * there, so followed, and the rest after it, which may not climb with `..`.
 */
async function resolved(at: string): Promise<string> {
  try {
    return await realpath(at)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const missing = [posix.basename(at)]
  for (let ancestor = posix.dirname(at); ; ancestor = posix.dirname(ancestor)) {
    try {
      const real = await realpath(ancestor)
      if (missing.includes('..')) throw Object.assign(new Error(`${at} climbs out of a folder that is not there`), { code: 'ENOENT' })
      return posix.join(real, ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === '/' || missing.includes('..')) throw error
      missing.unshift(posix.basename(ancestor))
    }
  }
}

function absolute(path: string): string {
  if (!isAbsolute(path)) throw invalid(`${path === '' ? 'an empty path' : path} is not an absolute path in the box`)
  return path
}
