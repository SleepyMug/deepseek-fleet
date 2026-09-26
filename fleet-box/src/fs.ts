/**
 * `ctx.fs` for the fleet execution world: every call of a session's turn runs
 * in that session's container, where the helper serves it with dsh's own
 * local file system, so the model's file tools behave as they do on a local
 * machine. The world does not confine file access itself, since the container
 * is the boundary, so `sandboxMode` stays unset and the file tools offer no
 * sandbox escalation. Every failure is an FsError: the helper's own, or
 * `FS_ABORTED` or `FS_IO_ERROR` for the rest, as with dsh's SSH file system.
 *
 * A call outside any turn, like the sidebar's file tree and previews or a
 * chat file link, reads the host instead, confined to the registered
 * workspace folders: each is bind-mounted into its sessions' containers at the
 * same path, so the host shows the same files, without starting a container.
 * What exists only in a container, such as its /tmp, is not there; paths are
 * judged after resolving symlinks, so a link out of the workspaces is refused,
 * though one swapped in between that check and the read is followed. These
 * calls only read and watch: writes and edits are left to the sessions' own
 * work.
 * @module fleet-box/fs
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type {} from '@deepseek-ai/dsh-workspace'
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
  static inject = ['fleetBox', 'workspaceRegistry']

  /** This service's own context, whose services it uses whoever calls it. */
  private readonly self: Context
  /** dsh's local file system in a context of its own: the host view, for calls outside any turn. */
  private readonly local = new Context()
  private readonly host: Promise<FileSystem>

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
    const fiber = this.local.plugin(LocalFileSystem, { cwd: '/' })
    this.host = Promise.resolve(fiber).then(() => this.local.fs)
    this.host.catch(() => {})
    ctx.effect(() => () => fiber.dispose(), 'fleet-box host view')
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const host = await this.outside()
    if (host !== undefined) return this.confine(await host.resolve(path, opts))
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
    const host = await this.outside()
    if (host !== undefined) return host.stat(await this.hostTarget(host, target, signal), signal)
    return await this.call('ctx.fs.stat', 'fs.stat', { target }, infoSchema.nullable(), signal) ?? undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const host = await this.outside()
    if (host !== undefined) {
      // The entry itself is not followed, so its folder must be a workspace's, unless it is a
      // workspace folder; a `.` or `..` entry is a folder reached through its parent, so it is judged itself.
      const spelling = localSpelling(opts?.cwd ?? '/', path)
      const entry = posix.basename(spelling)
      const [parent, itself] = await Promise.all([host.resolve(posix.dirname(spelling), { signal }), host.resolve(spelling, { signal })])
      const allowed = entry === '.' || entry === '..'
        ? this.inside(String(itself.targetKey))
        : this.inside(String(parent.targetKey)) || this.folders().includes(String(itself.targetKey))
      if (!allowed) throw outsideError(path)
      return host.lstat(path, opts, signal)
    }
    return await this.call('ctx.fs.lstat', 'fs.lstat', { path, cwd: opts?.cwd ?? null }, pathInfoSchema.nullable(), signal) ?? undefined
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const host = await this.outside()
    if (host !== undefined) return host.readText(await this.hostTarget(host, target, signal), signal)
    return this.call('ctx.fs.readText', 'fs.readText', { target }, z.string(), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const host = await this.outside()
    if (host !== undefined) return host.streamText(await this.hostTarget(host, target, signal), signal)
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
    const host = await this.outside()
    if (host !== undefined) return host.readBytes(await this.hostTarget(host, target, signal), signal, maxBytes)
    return bytes(await this.call('ctx.fs.readBytes', 'fs.readBytes', { target, maxBytes }, z.base64(), signal))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const host = await this.outside()
    if (host !== undefined) return host.readByteRange(await this.hostTarget(host, target, signal), range, signal)
    const data = await this.call('ctx.fs.readByteRange', 'fs.readRange', { target, offset: range.offset, length: range.length }, z.base64(), signal)
    return bytes(data)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const host = await this.outside()
    if (host !== undefined) return host.listDir(await this.hostTarget(host, target, signal), signal)
    return this.call('ctx.fs.listDir', 'fs.listDir', { target }, entriesSchema, signal)
  }

  /** Only the host view watches: the container's helper has no watches, so a turn's call fails as unsupported. */
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    const host = await this.outside()
    if (host !== undefined) return host.watch(await this.hostTarget(host, target, signal), changed, signal)
    return super.watch(target, changed, signal)
  }

  /** No sandbox policy applies: the container is the boundary. */
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    if (await this.outside() !== undefined) throw readOnlyError(target)
    return this.call('ctx.fs.writeText', 'fs.writeText', { target, content, expected: expected ?? null }, writeSchema, signal)
  }

  /** No sandbox policy applies: the container is the boundary. */
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    if (await this.outside() !== undefined) throw readOnlyError(target)
    return this.call('ctx.fs.editText', 'fs.editText', { target, edit, expected: expected ?? null }, editSchema, signal)
  }

  /** @returns the host view for a call outside any turn, or undefined for a session's call. */
  private async outside(): Promise<FileSystem | undefined> {
    return this.self.fleetBox.initiator() === undefined ? this.host : undefined
  }

  /** The workspace folders, as the registry keeps them: canonical paths. */
  private folders(): string[] {
    return this.self.workspaceRegistry.list().map(workspace => workspace.path)
  }

  private inside(path: string): boolean {
    return this.folders().some(folder => path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`))
  }

  /** A resolved target, refused unless its canonical path is in a workspace folder. */
  private confine(target: FsTarget): FsTarget {
    if (!this.inside(String(target.targetKey))) throw outsideError(target.displayPath)
    return target
  }

  /** A target to read on the host, resolved again, so a target made elsewhere cannot lead out of the workspaces. */
  private async hostTarget(host: FileSystem, target: FsTarget, signal?: AbortSignal): Promise<FsTarget> {
    const resolved = this.confine(await host.resolve(this.processPath(target), { signal }))
    return { targetKey: resolved.targetKey, displayPath: target.displayPath }
  }

  private async connection(operation: string, signal?: AbortSignal): Promise<HelperConnection> {
    return (await this.self.fleetBox.current(operation, signal)).world.connection
  }

  private async call<T>(operation: string, method: string, params: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const connection = await translate(this.connection(operation, signal), signal)
    return translate(connection.request(method, params, schema, signal), signal)
  }
}

/**
 * The path dsh's local file system probes for a POSIX path: a spelling with a
 * `..` segment is kept as it is, for the kernel to follow through symlinks,
 * and any other is normalized.
 */
function localSpelling(cwd: string, path: string): string {
  const raw = path.startsWith('/') ? path : `${cwd}/${path}`
  return /(?:^|\/)\.\.(?:\/|$)/u.test(raw) ? raw : posix.resolve(cwd, path)
}

function outsideError(path: string): FsError {
  return new FsError(`"${path}" is outside the workspace folders; outside a session's turn, the container world serves only files in them`,
    'FS_PERMISSION_DENIED')
}

function readOnlyError(target: FsTarget): FsError {
  return new FsError(`cannot write "${target.displayPath}" outside a session's turn; the container world only reads workspace files then`,
    'FS_PERMISSION_DENIED')
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
