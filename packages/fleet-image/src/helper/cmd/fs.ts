/**
 * dsh's file system in the box, for the host's `ctx.fs` (fleet-core's
 * world/fs.ts): every method is dsh's own local file system's, mounted here
 * in a cordis context of the helper's own, so the model's file tools behave
 * in the box as they do on a local machine. A target is the local one's:
 * its key is the canonical path in the box. A failure keeps the `FsError`
 * code, which the host gives back to dsh.
 * @module fleet-image/helper/cmd/fs
 */

import { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsEditRequest, FsTarget, FsTargetKey, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Methods, Target } from '../protocol.ts'

type Handler<M extends keyof Methods> = (params: Methods[M]['params']) => Promise<Methods[M]['result']>

let mounted: Promise<FileSystem> | undefined

/** dsh's local file system, mounted on first use; relative paths without a `cwd` are the helper's folder's. */
function fs(): Promise<FileSystem> {
  mounted ??= (async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    return ctx.fs as FileSystem
  })()
  return mounted
}

export const fsResolve: Handler<'fs.resolve'> = async ({ path, cwd }) =>
  wire(await (await fs()).resolve(text(path, 'path'), { cwd: optional(cwd, 'cwd') }))

export const fsStat: Handler<'fs.stat'> = async ({ target: t }) =>
  await (await fs()).stat(target(t)) ?? null

export const fsLstat: Handler<'fs.lstat'> = async ({ path, cwd }) =>
  await (await fs()).lstat(text(path, 'path'), { cwd: optional(cwd, 'cwd') }) ?? null

export const fsReadText: Handler<'fs.readText'> = async ({ target: t }) =>
  (await fs()).readText(target(t))

export const fsReadBytes: Handler<'fs.readBytes'> = async ({ target: t, maxBytes }) =>
  base64(await (await fs()).readBytes(target(t), undefined, count(maxBytes, 'maxBytes')))

export const fsReadRange: Handler<'fs.readRange'> = async ({ target: t, offset, length }) =>
  base64(await (await fs()).readByteRange(target(t), { offset: count(offset, 'offset'), length: count(length, 'length') }))

export const fsListDir: Handler<'fs.listDir'> = async ({ target: t }) =>
  (await (await fs()).listDir(target(t))).map(entry => ({ ...entry, target: wire(entry.target) }))

export const fsWriteText: Handler<'fs.writeText'> = async ({ target: t, content, expected }) =>
  (await fs()).writeText(target(t), text(content, 'content'), expected as FsWriteIntent | undefined)

export const fsEditText: Handler<'fs.editText'> = async ({ target: t, edit, expected }) =>
  (await fs()).editText(target(t), edit as FsEditRequest, expected as { version: FsVersion } | undefined)

function target(value: unknown): FsTarget {
  const { targetKey, displayPath } = (value ?? {}) as Partial<Target>
  return { targetKey: text(targetKey, 'targetKey') as FsTargetKey, displayPath: text(displayPath, 'displayPath') }
}

function wire(value: FsTarget): Target {
  return { targetKey: String(value.targetKey), displayPath: value.displayPath }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}

function optional(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, name)
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a whole number`)
  return value as number
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}
