/**
 * `ctx.fs` for the fleet execution world: every call is served in the
 * container of the session it is for, where the helper serves it with dsh's
 * own local file system, so the model's file tools and the user's file viewer
 * see what the session's processes see. The world does not confine file
 * access itself, since the container is the boundary, so `sandboxMode` stays
 * unset and the file tools offer no sandbox escalation.
 *
 * A target names its world: its key is `fleet-box://<root session><path>`,
 * the path in that root session's container, which dsh's consumers treat as
 * opaque, while its display and process paths are the plain container path.
 * A path or a `cwd` may name its world the same way: a relative path joins
 * the container path of such a `cwd`, and an absolute plain path with one is
 * a path in its container. The arguments decide the container, with whose
 * call it is; any call they do not serve is refused with
 * `FS_PERMISSION_DENIED`, and nothing reads the host instead:
 *
 * - A session's own work: its turn makes the call, or the call comes through
 *   the session agent's own context (./world.ts). A plain path is in its
 *   root session's container, and a container its arguments name must be
 *   that one, so the model never reaches another session's container. It
 *   reads and writes.
 * - Any other call must name its container, and only reads. This serves the
 *   file viewer: dsh's `workspaceFileScope` lookup, configured here, gives a
 *   session's folder as a path in its root session's container, and the
 *   `workspaceFiles` service passes that on to every file call as the path or
 *   the `cwd`, so the sidebar's file tree and previews, which the chat's file
 *   links open, and the change feed behind live refresh all read that
 *   container, whatever context they call from.
 *
 * So `/api/file`, which shows the chat's images of local paths, is refused:
 * its requests name no session, and its paths no container. Watching is not
 * served at all, since the helper has no watches; the change feed reports
 * that as watching unsupported.
 *
 * Every call occupies its container (./occupancy.ts) while it runs, and a
 * text stream until it ends or is closed, so a file access starts a stopped
 * container and keeps it running until it is done, as a turn would. An
 * archived session has no container, so its files are not served. Every
 * failure is an FsError: the helper's own, `FS_PERMISSION_DENIED` for a call
 * this world does not serve, or `FS_ABORTED` or `FS_IO_ERROR` for the rest,
 * as with dsh's SSH file system.
 * @module fleet-runtime/box/fs
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { HelperError, type HelperConnection } from './connection.ts'
import { usableAsContainerName, type FleetBox } from './world.ts'

const FS_ERROR_CODES: ReadonlySet<string> = new Set<FsErrorCode>([
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
])

/** How a target key, or a path naming its container, begins; the root session and the container path follow. */
const KEY_PREFIX = 'fleet-box://'

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
  /** Only a session's own work writes; any other call only reads. */
  writable: boolean
}

/** A path in a container, or a plain path, which names none. */
interface Place {
  /** The root session whose container the path names, if it names one. */
  root: SessionId | undefined
  /** The path as the helper takes it. */
  path: string
}

export class FleetBoxFileSystem extends FileSystem {
  static inject = ['fleetBox']

  /** This service's own context, whose services it uses whoever calls it. */
  private readonly self: Context

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
    // The file viewer's service is given each session's folder in its container, and passes it on to every file call.
    ctx.inject(['fleetBox', 'typert'], (inner) => {
      inner.typert.lookups.configure('workspaceFileScope', id => workspaceFileScope(inner.fleetBox, id))
    })
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const { scope, params } = await this.onPath('ctx.fs.resolve', path, opts?.cwd)
    const target = await this.call(scope, 'fs.resolve', params, targetSchema, opts?.signal)
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
    const { scope, inContainer } = await this.onTarget('ctx.fs.stat', target)
    return await this.call(scope, 'fs.stat', { target: inContainer }, infoSchema.nullable(), signal) ?? undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const { scope, params } = await this.onPath('ctx.fs.lstat', path, opts?.cwd)
    return await this.call(scope, 'fs.lstat', params, pathInfoSchema.nullable(), signal) ?? undefined
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const { scope, inContainer } = await this.onTarget('ctx.fs.readText', target)
    return this.call(scope, 'fs.readText', { target: inContainer }, z.string(), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const { scope, inContainer } = await this.onTarget('ctx.fs.streamText', target)
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
    const { scope, inContainer } = await this.onTarget('ctx.fs.readBytes', target)
    return bytes(await this.call(scope, 'fs.readBytes', { target: inContainer, maxBytes }, z.base64(), signal))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const { scope, inContainer } = await this.onTarget('ctx.fs.readByteRange', target)
    const params = { target: inContainer, offset: range.offset, length: range.length }
    return bytes(await this.call(scope, 'fs.readRange', params, z.base64(), signal))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const { scope, inContainer } = await this.onTarget('ctx.fs.listDir', target)
    const entries = await this.call(scope, 'fs.listDir', { target: inContainer }, entriesSchema, signal)
    return entries.map(entry => ({ ...entry, target: qualify(scope.root.id, entry.target) }))
  }

  /** No sandbox policy applies: the container is the boundary. */
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    const { scope, inContainer } = await this.onTarget('ctx.fs.writeText', target)
    if (!scope.writable) throw readOnlyError(target)
    const params = { target: inContainer, content, expected: expected ?? null }
    return this.call(scope, 'fs.writeText', params, writeSchema, signal)
  }

  /** No sandbox policy applies: the container is the boundary. */
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    const { scope, inContainer } = await this.onTarget('ctx.fs.editText', target)
    if (!scope.writable) throw readOnlyError(target)
    const params = { target: inContainer, edit, expected: expected ?? null }
    return this.call(scope, 'fs.editText', params, editSchema, signal)
  }

  /**
   * Whose container serves a call on a path, and the path and `cwd` as the
   * helper there takes them. The path names its container, or else the `cwd`
   * does; a call whose two name different ones is refused.
   */
  private async onPath(operation: string, path: string, cwd: string | undefined): Promise<{ scope: Scope; params: { path: string; cwd: string | null } }> {
    const place = placeOf(path)
    const base = cwd === undefined ? undefined : placeOf(cwd)
    if (place.root !== undefined && base?.root !== undefined && place.root !== base.root) {
      throw new FsError(`${operation} names two containers, ${place.root}'s and ${base.root}'s`, 'FS_PERMISSION_DENIED')
    }
    const scope = await this.scope(operation, place.root ?? base?.root)
    return { scope, params: { path: place.path, cwd: base?.path ?? null } }
  }

  /** Whose container serves a call on a target, and the target as the helper there names it. */
  private async onTarget(operation: string, target: FsTarget): Promise<{ scope: Scope; inContainer: HelperTarget }> {
    const { root, path } = located(target)
    return { scope: await this.scope(operation, root), inContainer: { targetKey: path, displayPath: target.displayPath } }
  }

  /**
   * Whose container serves the current call. A session's own work is served
   * in its root session's container, which any container its arguments name
   * must be; any other call is served in the container its arguments name,
   * and only reads.
   * @param operation - the provider method, named in the error for a call this world does not serve.
   * @param named - the root session whose container the call's arguments name, if they name one.
   */
  private async scope(operation: string, named: SessionId | undefined): Promise<Scope> {
    const fleetBox = this.self.fleetBox
    const agent = fleetBox.sessionAgent(this.ctx)
    if (agent !== undefined) {
      const root = await translate(fleetBox.rootHeaderOf(agent.session.header.id), undefined)
      if (named !== undefined && named !== root.id) {
        throw new FsError(`${operation} names the container of session ${named}; a session's work reaches only its own`, 'FS_PERMISSION_DENIED')
      }
      return { root, writable: true }
    }
    if (named === undefined) {
      throw new FsError(`${operation} was called outside a session's work with a path that names no container; `
        + 'the container world serves a plain path only to a session\'s own work', 'FS_PERMISSION_DENIED')
    }
    const root = await translate(fleetBox.rootHeaderOf(named), undefined)
    if (root.id !== named || root.origin === 'subagent') {
      throw new FsError(`${operation} names session ${named}, which has no container of its own`, 'FS_PERMISSION_DENIED')
    }
    return { root, writable: false }
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
 * dsh's `workspaceFileScope` lookup, which the file viewer's service resolves
 * a session with: the session's folder as a path in its root session's
 * container, which that service passes on to every file call it makes for
 * the session, so each call names the container.
 * @param fleetBox - the world, which knows the session's header and its root's.
 * @returns the scope, or undefined for a session not known, without an absolute folder, or with no container.
 */
async function workspaceFileScope(
  fleetBox: Pick<FleetBox, 'sessionHeader' | 'rootHeaderOf'>, sessionId: SessionId,
): Promise<WorkspaceFileScope | undefined> {
  const header = await fleetBox.sessionHeader(sessionId)
  if (header?.cwd === undefined || !posix.isAbsolute(header.cwd)) return undefined
  const root = await fleetBox.rootHeaderOf(sessionId)
  if (root.origin === 'subagent' || !usableAsContainerName(root.id)) return undefined
  return { sessionId, workspaceRoot: qualifiedPath(root.id, header.cwd) }
}

/** A path in a root session's container, written to name the container; a target's key is one. */
function qualifiedPath(root: SessionId, path: string): string {
  return `${KEY_PREFIX}${root}${path}`
}

/**
 * The container a path names, if any, and the path in it.
 * @throws FS_PERMISSION_DENIED for a path that begins as one naming a container, but names no path in
 *   a container a session id could name.
 */
function placeOf(path: string): Place {
  if (!path.startsWith(KEY_PREFIX)) return { root: undefined, path }
  const slash = path.indexOf('/', KEY_PREFIX.length)
  const root = slash === -1 ? '' : path.slice(KEY_PREFIX.length, slash)
  if (!usableAsContainerName(root)) throw new FsError(`"${path}" names no path in a session's container`, 'FS_PERMISSION_DENIED')
  return { root: root as SessionId, path: path.slice(slash) }
}

/** A target the helper names, as a target of a root session's container. */
function qualify(root: SessionId, target: HelperTarget): FsTarget {
  return { targetKey: FsTargetKey(qualifiedPath(root, target.targetKey)), displayPath: target.displayPath }
}

/**
 * The root session and container path a target names.
 * @throws FS_PERMISSION_DENIED for a target this world did not make.
 */
function located(target: FsTarget): { root: SessionId; path: string } {
  const { root, path } = placeOf(String(target.targetKey))
  if (root === undefined) throw new FsError(`"${target.displayPath}" is not a target of the container world`, 'FS_PERMISSION_DENIED')
  return { root, path }
}

function readOnlyError(target: FsTarget): FsError {
  return new FsError(`cannot write "${target.displayPath}" outside a session's own work, which alone writes in its container`,
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
