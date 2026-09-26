/**
 * `ctx.fs` for the fleet execution world: every call runs in the container of
 * the session whose agent made it, where the helper serves it with dsh's own
 * local file system, so the model's file tools behave as they do on a local
 * machine. A call outside any session's work, like a sidebar view or a file
 * link, fails instead of reading the host. The world does not confine file
 * access itself, since the container is the boundary, so `sandboxMode` stays
 * unset and the file tools offer no sandbox escalation. Every failure is an
 * FsError: the helper's own, or `FS_ABORTED` or `FS_IO_ERROR` for the rest,
 * as with dsh's SSH file system.
 * @module fleet-box/fs
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { HelperError, type HelperConnection } from './connection.ts'
import type {} from './world.ts'

const FS_ERROR_CODES: ReadonlySet<string> = new Set<FsErrorCode>([
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
])

const absolutePath = z.string().refine(path => path.startsWith('/') && !path.includes('\0'), 'expected an absolute path')
const version = z.string().transform(FsVersion)
const size = z.number().nonnegative().optional()
const targetSchema = z.object({ targetKey: absolutePath.transform(FsTargetKey), displayPath: z.string() })
const infoSchema = z.object({ version, type: z.enum(['file', 'directory', 'other']), size })
const pathInfoSchema = z.object({ version, type: z.enum(['file', 'directory', 'symlink', 'other']), size })
const entriesSchema = z.array(z.object({
  name: z.string(), type: z.enum(['file', 'directory', 'other']), target: targetSchema, version: version.optional(), size,
}))
const writeSchema = z.object({ operation: z.enum(['create', 'update']), version, before: z.string().nullable(), after: z.string() })
const editSchema = z.object({ version, before: z.string(), after: z.string() })
const chunkSchema = z.object({ done: z.boolean(), value: z.string() })

export class FleetBoxFileSystem extends FileSystem {
  static inject = ['fleetBox']

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.call('ctx.fs.resolve', 'fs.resolve', { path, cwd: opts?.cwd ?? null }, targetSchema, opts?.signal)
  }

  /** The helper's target key is the canonical path in the container, where its processes see the file too. */
  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = posix.relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return await this.call('ctx.fs.stat', 'fs.stat', { target }, infoSchema.nullable(), signal) ?? undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return await this.call('ctx.fs.lstat', 'fs.lstat', { path, cwd: opts?.cwd ?? null }, pathInfoSchema.nullable(), signal) ?? undefined
  }

  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.call('ctx.fs.readText', 'fs.readText', { target }, z.string(), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const connection = await translate(this.connection('ctx.fs.streamText', signal), signal)
    const stream = await translate(connection.request('fs.streamOpen', { target }, z.number().int(), signal), signal)
    return (async function* () {
      let done = false
      try {
        while (!done) {
          const chunk = await translate(connection.request('fs.streamNext', { stream }, chunkSchema, signal), signal)
          done = chunk.done
          if (!done) yield chunk.value
        }
      } finally {
        if (!done) await connection.request('fs.streamClose', { stream }, z.null()).catch(() => {})
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return bytes(await this.call('ctx.fs.readBytes', 'fs.readBytes', { target, maxBytes }, z.base64(), signal))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const data = await this.call('ctx.fs.readByteRange', 'fs.readRange', { target, offset: range.offset, length: range.length }, z.base64(), signal)
    return bytes(data)
  }

  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.call('ctx.fs.listDir', 'fs.listDir', { target }, entriesSchema, signal)
  }

  /** No sandbox policy applies: the container is the boundary. */
  override writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.call('ctx.fs.writeText', 'fs.writeText', { target, content, expected: expected ?? null }, writeSchema, signal)
  }

  /** No sandbox policy applies: the container is the boundary. */
  override editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return this.call('ctx.fs.editText', 'fs.editText', { target, edit, expected: expected ?? null }, editSchema, signal)
  }

  private async connection(operation: string, signal?: AbortSignal): Promise<HelperConnection> {
    return (await this.ctx.fleetBox.current(operation, signal)).world.connection
  }

  private async call<T>(operation: string, method: string, params: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const connection = await translate(this.connection(operation, signal), signal)
    return translate(connection.request(method, params, schema, signal), signal)
  }
}

/**
 * A dsh-fs failure the helper reported becomes the same FsError the local
 * file system throws; any other failure, such as a world that did not open
 * or a lost helper, becomes `FS_IO_ERROR`, or `FS_ABORTED` once cancelled.
 */
async function translate<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try {
    return await operation
  } catch (error) {
    if (error instanceof FsError) throw error
    if (error instanceof HelperError && error.code !== undefined && FS_ERROR_CODES.has(error.code)) {
      throw new FsError(error.message, error.code as FsErrorCode, { cause: error })
    }
    throw new FsError(error instanceof Error ? error.message : String(error), signal?.aborted === true ? 'FS_ABORTED' : 'FS_IO_ERROR', { cause: error })
  }
}

function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

export default FleetBoxFileSystem
