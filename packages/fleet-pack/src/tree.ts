/**
 * Trees of files as tar archives (./tar.ts): a folder's entries to write,
 * with files, symlinks and folders of one's own beside them, so that one
 * archive can be put together from several places; and an archive
 * unpacked into a folder, which keeps what it holds unless the archive
 * replaces it. Unpacking never writes through a symlink, whether the
 * archive made it or the folder had it, unless it is told to follow them,
 * as into a box's own folders.
 * @module @sleepymug/fleet-pack/tree
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readTar, writeTar, type WriteEntry } from './tar.ts'

/** The entries of the tree at `dir`, under `at` (`''` for the archive's root): folders before what they hold, in order of name; what is neither a file, a folder nor a symlink is left out. */
export async function* treeEntries(dir: string, at = ''): AsyncGenerator<WriteEntry> {
  const names = (await readdir(dir)).sort()
  for (const name of names) {
    const path = join(dir, name)
    const entry = await pathEntry(path, at === '' ? name : posix.join(at, name))
    if (entry === undefined) continue
    yield entry
    if (entry.type === 'dir') yield* treeEntries(path, entry.name)
  }
}

/** The entry of what is at `path`, symlinks not followed, as `at`; undefined for what is neither a file, a folder nor a symlink. */
export async function pathEntry(path: string, at: string): Promise<WriteEntry | undefined> {
  const info = await lstat(path)
  const mode = info.mode & 0o777
  if (info.isSymbolicLink()) return { name: at, type: 'symlink', mode, size: 0, target: await readlink(path) }
  if (info.isDirectory()) return { name: at, type: 'dir', mode, size: 0 }
  if (info.isFile()) return { name: at, type: 'file', mode, size: info.size, body: () => createReadStream(path) }
  return undefined
}

/** A file of the archive's own, `bytes` at `at`. */
export function bytesEntry(at: string, bytes: string | Uint8Array, mode = 0o644): WriteEntry {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
  return { name: at, type: 'file', mode, size: data.length, body: async function* () { yield data } }
}

/** A symlink of the archive's own, at `at`, to `target`. */
export function linkEntry(at: string, target: string): WriteEntry {
  return { name: at, type: 'symlink', mode: 0o777, size: 0, target }
}

/** A folder of the archive's own, at `at`. */
export function dirEntry(at: string, mode = 0o755): WriteEntry {
  return { name: at, type: 'dir', mode, size: 0 }
}

/** The tree at `dir` as an archive. */
export function packTree(dir: string): AsyncGenerator<Uint8Array> {
  return writeTar(treeEntries(dir))
}

export interface UnpackOptions {
  /** What the archive is, as a refusal names it. */
  what?: string
  /** Write through the symlinks the folder has, and the archive makes, as into a box's own folders. */
  followLinks?: boolean
}

/**
 * Unpack an archive into `dir`, made if it is missing: each entry in place
 * of what is at its path, and what is there and not in the archive kept.
 * A file or a folder has its mode as the archive says, a folder's set once
 * everything in it is written.
 */
export async function unpackTree(bytes: AsyncIterable<Uint8Array>, dir: string, options: UnpackOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  const root = await realpath(dir)
  const folders: [string, number][] = []
  for await (const entry of readTar(bytes, options.what)) {
    const parts = entry.name.split('/')
    if (options.followLinks !== true) await refuseLinks(root, parts.slice(0, -1), entry.name)
    const path = join(root, ...parts)
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true })
    const there = await lstat(path).catch(() => undefined)
    if (entry.type === 'dir') {
      if (there !== undefined && !there.isDirectory()) await rm(path, { force: true })
      await mkdir(path, { recursive: true })
      folders.push([path, entry.mode])
      continue
    }
    if (there !== undefined && !(entry.type === 'file' && there.isFile())) await rm(path, { recursive: true, force: true })
    if (entry.type === 'symlink') {
      await symlink(entry.target as string, path)
      continue
    }
    await pipeline(Readable.from(entry.body), createWriteStream(path, { mode: entry.mode }))
    await chmod(path, entry.mode)
  }
  // The innermost first, so that a folder that cannot be written to is set last.
  for (const [path, mode] of folders.reverse()) await chmod(path, mode)
}

/** Refuse an entry whose folders, under `root`, have a symlink among them, which writing it would write through. */
async function refuseLinks(root: string, folders: readonly string[], name: string): Promise<void> {
  let at = root
  for (const folder of folders) {
    at = `${at}${sep}${folder}`
    const info = await lstat(at).catch(() => undefined)
    if (info === undefined) return
    if (info.isSymbolicLink()) throw new Error(`${name} is in ${folder}, a symlink, which unpacking does not write through`)
  }
}
