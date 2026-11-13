/**
 * The box's files, as `Box` serves them: what is at a path, what a folder
 * holds, a file read and written as a stream of its bytes, folders made,
 * and things removed and moved; and trees, a folder's contents or a file,
 * as tar archives, in and out (fleet-pack). Every path is absolute; a
 * failure is reported by its errno (../errors.ts).
 * @module @sleepymug/fleet-box/helper/box/files
 */

import { createReadStream, createWriteStream, type Stats } from 'node:fs'
import { lstat, mkdir, readdir, readlink, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import {
  type FileInfo, FileInfoSchema, FileType, type GetRequest, type ListDirRequest, type MakeDirRequest, type PutRequest, type ReadFileRequest,
  type RemoveRequest, type RenameRequest, type StatRequest, type WriteFileRequest, type WriteFileResponseSchema,
} from '@sleepymug/fleet-protocol/box'
import { packTree, pathEntry, unpackTree, writeTar } from '@sleepymug/fleet-pack'
import { invalid, systemError } from '../errors.ts'

export async function statOf({ path, follow }: StatRequest): Promise<{ info?: FileInfo }> {
  const at = absolute(path)
  try {
    return { info: await infoOf(at, follow ? await stat(at) : await lstat(at)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw systemError(error, `stat ${at}`)
  }
}

export async function listDir({ path }: ListDirRequest) {
  const at = absolute(path)
  try {
    const names = (await readdir(at)).sort()
    const entries = await Promise.all(names.map(async (name) => {
      const child = `${at === '/' ? '' : at}/${name}`
      const info = await lstat(child).then(found => infoOf(child, found), () => undefined)
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

export async function writeFile(requests: AsyncIterable<WriteFileRequest>): Promise<MessageInitShape<typeof WriteFileResponseSchema>> {
  const iterator = requests[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done === true || first.value.request.case !== 'start') throw invalid('a write starts with which file')
  const { path, mode, parents, exclusive, append } = first.value.request.value
  const at = absolute(path)
  try {
    if (parents) await mkdir(dirname(at), { recursive: true })
    const flags = exclusive ? (append ? 'ax' : 'wx') : (append ? 'a' : 'w')
    const chunks = async function* () {
      for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
        if (next.value.request.case === 'chunk') yield next.value.request.value
        else throw invalid('a write starts once')
      }
    }
    await pipeline(Readable.from(chunks()), createWriteStream(at, { flags, mode: mode ?? 0o644 }))
    return { size: BigInt((await stat(at)).size) }
  } catch (error) {
    throw systemError(error, `write ${at}`)
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

async function infoOf(path: string, info: Stats): Promise<FileInfo> {
  const type = info.isFile() ? FileType.FILE : info.isDirectory() ? FileType.DIRECTORY : info.isSymbolicLink() ? FileType.SYMLINK : FileType.OTHER
  return create(FileInfoSchema, {
    type,
    size: BigInt(info.size),
    mode: info.mode & 0o7777,
    modified: timestampFromDate(info.mtime),
    target: type === FileType.SYMLINK ? await readlink(path) : '',
  })
}

function absolute(path: string): string {
  if (!isAbsolute(path)) throw invalid(`${path === '' ? 'an empty path' : path} is not an absolute path in the box`)
  return path
}
