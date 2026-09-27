/**
 * `ctx.fs` for the fleet execution world: every call is served in the
 * container of the session it is for, where the helper serves it with dsh's
 * own local file system, so the model's file tools and the user's file viewer
 * see what the session's processes see. The world does not confine file
 * access itself, since the container is the boundary, so `sandboxMode` stays
 * unset and the file tools offer no sandbox escalation.
 *
 * A call is a session's in one of two ways; any other is refused with
 * `FS_PERMISSION_DENIED`, and nothing reads the host instead:
 *
 * - The session's own work: its turn makes the call, or the call comes
 *   through the session agent's own context (./world.ts). It reads and writes.
 * - The file viewer: a `workspaceFiles` Remote call, which names its session
 *   in `workspaceFileScopeId`. dsh's Gateway runs a Remote method on a
 *   context carrying the call, which cordis hands on as the provider's
 *   `this.ctx`. It serves the sidebar's file tree and previews, which the
 *   chat's file links open, and only reads.
 *
 * So these are refused, for want of a session: `/api/file`, which shows the
 * chat's images of local paths, and the change feed behind live refresh
 * (`workspaceFiles.changes`), which resolves its paths from a context of its
 * own. Watching is not served at all, since the helper has no watches.
 *
 * A target names its world: its key is `fleet-box://<root session><path>`,
 * the path in that root session's container, which dsh's consumers treat as
 * opaque, while its display and process paths are the plain container path.
 * A call on a target must be the target's session's, so a target never
 * reaches another session's container.
 *
 * Every call occupies its container (./occupancy.ts) while it runs, and a
 * text stream until it ends or is closed, so a file access starts a stopped
 * container and keeps it running until it is done, as a turn would. An
 * archived session has no container, so its files are not served. Every
 * failure is an FsError: the helper's own, `FS_PERMISSION_DENIED` for a call
 * this world does not serve, or `FS_ABORTED` or `FS_IO_ERROR` for the rest,
 * as with dsh's SSH file system.
 * @module fleet-box/fs
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { HelperError, type HelperConnection } from './connection.ts'
import type {} from './world.ts'

const FS_ERROR_CODES: ReadonlySet<string> = new Set<FsErrorCode>([
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
])

/** How a target key begins; the root session and the container path follow. */
const KEY_PREFIX = 'fleet-box://'

/** The Remote service whose calls are the file viewer's, and the argument naming their session. */
const VIEWER_SERVICE = 'workspaceFiles'
const VIEWER_SESSION = 'workspaceFileScopeId'

/** A target as the helper names it: by its canonical path in the container. */
interface HelperTarget {
  targetKey: string
  displayPath: string
}

const absolutePath = z.string().refine(path => path.startsWith('/') && !path.includes('\0'), 'expected an absolute path')
const version = z.string().transform(FsVersion)
const size = z.number().nonnegative().optional()
const targetSchema = z.object({ targetKey: absolutePath, displayPath: z.string() })
const infoSchema = z.object({ version, type: z.enum(['file', 'directory', 'other']), size })
const pathInfoSchema = z.object({ version, type: z.enum(['file', 'directory', 'symlink', 'other']), size })
const entriesSchema = z.array(z.object({
  name: z.string(), type: z.enum(['file', 'directory', 'other']), target: targetSchema, version: version.optional(), size,
}))
const writeSchema = z.object({ operation: z.enum(['create', 'update']), version, before: z.string().nullable(), after: z.string() })
const editSchema = z.object({ version, before: z.string(), after: z.string() })
const chunkSchema = z.object({ done: z.boolean(), value: z.string() })

/** Whose container serves a call. */
interface Scope {
  /** The root session whose container it is. */
  root: SessionHeader
  /** Only a session's own work writes; the file viewer only reads. */
  writable: boolean
}

export class FleetBoxFileSystem extends FileSystem {
  static inject = ['fleetBox']

  /** This service's own context, whose services it uses whoever calls it. */
  private readonly self: Context

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const scope = await this.scope('ctx.fs.resolve')
    const target = await this.call(scope, 'fs.resolve', { path, cwd: opts?.cwd ?? null }, targetSchema, opts?.signal)
    return qualify(scope.root.id, target)
  }

  /** The path in the target's container, where its processes see the file too. */
  override processPath(target: FsTarget): string {
    return located(target).path
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  /** Only a target in the same container can be inside another. */
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const outer = located(parent)
    const inner = located(child)
    if (outer.root !== inner.root) return false
    const path = posix.relative(outer.path, inner.path)
    return path === '' || (path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const scope = await this.scope('ctx.fs.stat')
    return await this.call(scope, 'fs.stat', { target: helperTarget(scope, target) }, infoSchema.nullable(), signal) ?? undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const scope = await this.scope('ctx.fs.lstat')
    return await this.call(scope, 'fs.lstat', { path, cwd: opts?.cwd ?? null }, pathInfoSchema.nullable(), signal) ?? undefined
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const scope = await this.scope('ctx.fs.readText')
    return this.call(scope, 'fs.readText', { target: helperTarget(scope, target) }, z.string(), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const scope = await this.scope('ctx.fs.streamText')
    const inContainer = helperTarget(scope, target)
    const release = this.occupy(scope)
    try {
      const { connection } = await translate(this.self.fleetBox.forRoot(scope.root, signal), signal)
      const stream = await translate(connection.request('fs.streamOpen', { target: inContainer }, z.number().int(), signal), signal)
      return new TextStream(connection, stream, release, signal)
    } catch (error) {
      release()
      throw error
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const scope = await this.scope('ctx.fs.readBytes')
    return bytes(await this.call(scope, 'fs.readBytes', { target: helperTarget(scope, target), maxBytes }, z.base64(), signal))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const scope = await this.scope('ctx.fs.readByteRange')
    const params = { target: helperTarget(scope, target), offset: range.offset, length: range.length }
    return bytes(await this.call(scope, 'fs.readRange', params, z.base64(), signal))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const scope = await this.scope('ctx.fs.listDir')
    const entries = await this.call(scope, 'fs.listDir', { target: helperTarget(scope, target) }, entriesSchema, signal)
    return entries.map(entry => ({ ...entry, target: qualify(scope.root.id, entry.target) }))
  }

  /** No sandbox policy applies: the container is the boundary. */
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    const scope = await this.scope('ctx.fs.writeText')
    if (!scope.writable) throw readOnlyError(target)
    const params = { target: helperTarget(scope, target), content, expected: expected ?? null }
    return this.call(scope, 'fs.writeText', params, writeSchema, signal)
  }

  /** No sandbox policy applies: the container is the boundary. */
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    const scope = await this.scope('ctx.fs.editText')
    if (!scope.writable) throw readOnlyError(target)
    const params = { target: helperTarget(scope, target), edit, expected: expected ?? null }
    return this.call(scope, 'fs.editText', params, editSchema, signal)
  }

  /**
   * Whose container serves the current call: the session whose own work it
   * is, or the session whose files the viewer shows.
   * @param operation - the provider method, named in the error for a call no session makes.
   */
  private async scope(operation: string): Promise<Scope> {
    const fleetBox = this.self.fleetBox
    const agent = fleetBox.sessionAgent(this.ctx)
    const session = agent?.session.header.id ?? viewedSession(this.ctx)
    if (session === undefined) {
      throw new FsError(`${operation} was called outside a session; the container world serves only a session's own work `
        + 'and its file viewer', 'FS_PERMISSION_DENIED')
    }
    return { root: await translate(fleetBox.rootHeaderOf(session), undefined), writable: agent !== undefined }
  }

  /** Occupy the scope's container for one call; the release is idempotent. */
  private occupy(scope: Scope): () => void {
    return this.self.fleetBox.occupy(scope.root.id, { kind: 'file', id: randomUUID() })
  }

  /** One request to the helper in the scope's container, which it occupies until the answer. */
  private async call<T>(scope: Scope, method: string, params: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const release = this.occupy(scope)
    try {
      const { connection } = await translate(this.self.fleetBox.forRoot(scope.root, signal), signal)
      return await translate(connection.request(method, params, schema, signal), signal)
    } finally {
      release()
    }
  }
}

/**
 * One text stream the helper holds open, read a chunk at a time. It keeps its
 * container occupied until it is read to its end, closed with `return`, or its
 * signal aborts, whether or not it was ever read.
 */
class TextStream implements AsyncIterableIterator<string> {
  private done = false

  constructor(
    private readonly connection: HelperConnection,
    private readonly stream: number,
    private readonly release: () => void,
    private readonly signal: AbortSignal | undefined,
  ) {
    if (signal?.aborted === true) void this.finish(true)
    else signal?.addEventListener('abort', this.aborted, { once: true })
  }

  [Symbol.asyncIterator](): this {
    return this
  }

  async next(): Promise<IteratorResult<string>> {
    if (this.done) return { done: true, value: undefined }
    let chunk: z.infer<typeof chunkSchema>
    try {
      chunk = await translate(this.connection.request('fs.streamNext', { stream: this.stream }, chunkSchema, this.signal), this.signal)
    } catch (error) {
      await this.finish(true)
      throw error
    }
    if (!chunk.done) return { done: false, value: chunk.value }
    // The helper closed the stream at its end.
    await this.finish(false)
    return { done: true, value: undefined }
  }

  async return(): Promise<IteratorResult<string>> {
    await this.finish(true)
    return { done: true, value: undefined }
  }

  async throw(error?: unknown): Promise<IteratorResult<string>> {
    await this.finish(true)
    throw error
  }

  private readonly aborted = (): void => {
    void this.finish(true)
  }

  /** End the stream once: release its container, and close it in the helper unless it ended there. */
  private async finish(close: boolean): Promise<void> {
    if (this.done) return
    this.done = true
    this.signal?.removeEventListener('abort', this.aborted)
    this.release()
    if (close) await this.connection.request('fs.streamClose', { stream: this.stream }, z.null()).catch(() => {})
  }
}

/**
 * The session a file-viewer call is for. dsh's Gateway runs a Remote method
 * on a context carrying the call as `invocation`, which dsh defines once its
 * first Remote service loads; reading it before then would throw, so it is
 * looked up first.
 * @param caller - the context the provider was reached through, its traced `this.ctx`.
 * @returns the session, or undefined for a call that is not the viewer's.
 */
export function viewedSession(caller: Context): SessionId | undefined {
  if (!Object.hasOwn(caller.root.reflect.props, 'invocation')) return undefined
  const invocation: RemoteInvocation | undefined = caller.invocation
  if (invocation?.service !== VIEWER_SERVICE) return undefined
  const session = invocation.request.args[VIEWER_SESSION]
  return typeof session === 'string' && session !== '' ? session as SessionId : undefined
}

/** A target the helper names, as a target of a root session's container. */
function qualify(root: SessionId, target: HelperTarget): FsTarget {
  return { targetKey: FsTargetKey(`${KEY_PREFIX}${root}${target.targetKey}`), displayPath: target.displayPath }
}

/**
 * The root session and container path a target names.
 * @throws FS_PERMISSION_DENIED for a target this world did not make.
 */
function located(target: FsTarget): { root: SessionId; path: string } {
  const key = String(target.targetKey)
  const slash = key.indexOf('/', KEY_PREFIX.length)
  if (!key.startsWith(KEY_PREFIX) || slash <= KEY_PREFIX.length) {
    throw new FsError(`"${target.displayPath}" is not a target of the container world`, 'FS_PERMISSION_DENIED')
  }
  return { root: key.slice(KEY_PREFIX.length, slash) as SessionId, path: key.slice(slash) }
}

/**
 * A target as the helper in the scope's container names it.
 * @throws FS_PERMISSION_DENIED for a target of another session's container.
 */
function helperTarget(scope: Scope, target: FsTarget): HelperTarget {
  const { root, path } = located(target)
  if (root !== scope.root.id) throw new FsError(`"${target.displayPath}" is in another session's container`, 'FS_PERMISSION_DENIED')
  return { targetKey: path, displayPath: target.displayPath }
}

function readOnlyError(target: FsTarget): FsError {
  return new FsError(`cannot write "${target.displayPath}" from the file viewer; only a session's own work writes in its container`,
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
