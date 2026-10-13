/**
 * dsh's file system in the box, for the host's `ctx.fs` (fleet-core's
 * world/fs.ts): every method is dsh's own local file system's, mounted here
 * in a cordis context of the helper's own, so the model's file tools behave
 * in the box as they do on a local machine. A target is the local one's:
 * its key is the canonical path in the box. A failure keeps the `FsError`
 * code, which the host gives back to dsh. Each helper has its own
 * {@link Files}.
 * @module @sleepymug/fleet-box-runtime/helper/cmd/fs
 */

import { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsEditRequest, FsTarget, FsTargetKey, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { EventOf, Methods, Target } from '../protocol.ts'

type Params<M extends keyof Methods> = Methods[M]['params']
type Result<M extends keyof Methods> = Methods[M]['result']

interface Watching {
  stop: Promise<() => Promise<void>>
  ended: () => void
}

/** The files of the box as one helper serves them, and its watches, which end with it. */
export class Files {
  private mounted: Promise<FileSystem> | undefined
  /** Watches running, by the host's id. */
  private readonly watches = new Map<string, Watching>()

  /** @param cwd - the folder relative paths without a `cwd` are in. */
  constructor(private readonly cwd: string) {}

  async resolve({ path, cwd }: Params<'fs.resolve'>): Promise<Result<'fs.resolve'>> {
    return wire(await (await this.fs()).resolve(text(path, 'path'), { cwd: optional(cwd, 'cwd') }))
  }

  async stat({ target: t }: Params<'fs.stat'>): Promise<Result<'fs.stat'>> {
    return await (await this.fs()).stat(target(t)) ?? null
  }

  async lstat({ path, cwd }: Params<'fs.lstat'>): Promise<Result<'fs.lstat'>> {
    return await (await this.fs()).lstat(text(path, 'path'), { cwd: optional(cwd, 'cwd') }) ?? null
  }

  async readText({ target: t }: Params<'fs.readText'>): Promise<Result<'fs.readText'>> {
    return (await this.fs()).readText(target(t))
  }

  async readBytes({ target: t, maxBytes }: Params<'fs.readBytes'>): Promise<Result<'fs.readBytes'>> {
    return base64(await (await this.fs()).readBytes(target(t), undefined, count(maxBytes, 'maxBytes')))
  }

  async readRange({ target: t, offset, length }: Params<'fs.readRange'>): Promise<Result<'fs.readRange'>> {
    return base64(await (await this.fs()).readByteRange(target(t), { offset: count(offset, 'offset'), length: count(length, 'length') }))
  }

  async listDir({ target: t }: Params<'fs.listDir'>): Promise<Result<'fs.listDir'>> {
    return (await (await this.fs()).listDir(target(t))).map(entry => ({ ...entry, target: wire(entry.target) }))
  }

  async writeText({ target: t, content, expected }: Params<'fs.writeText'>): Promise<Result<'fs.writeText'>> {
    return (await this.fs()).writeText(target(t), text(content, 'content'), expected as FsWriteIntent | undefined)
  }

  async editText({ target: t, edit, expected }: Params<'fs.editText'>): Promise<Result<'fs.editText'>> {
    return (await this.fs()).editText(target(t), edit as FsEditRequest, expected as { version: FsVersion } | undefined)
  }

  /** Watch a target until `fs.unwatch`, sending an event each time it may have changed. */
  async watch({ watch: id, target: t }: Params<'fs.watch'>, emit: (event: EventOf<'fs.watch'>) => boolean): Promise<null> {
    const watch = text(id, 'watch')
    if (this.watches.has(watch)) throw new Error(`watch ${watch} already exists`)
    const controller = new AbortController()
    const ended = Promise.withResolvers<void>()
    const stop = (async () => {
      const dispose = await (await this.fs()).watch(target(t), (error) => { emit({ error: error === undefined ? null : error.message }) }, controller.signal)
      return async () => {
        controller.abort()
        await dispose()
      }
    })()
    this.watches.set(watch, { stop, ended: ended.resolve })
    try {
      await stop
    } catch (error) {
      this.watches.delete(watch)
      throw error
    }
    await ended.promise
    return null
  }

  /** End a watch, whose request then answers. */
  async unwatch({ watch: id }: Params<'fs.unwatch'>): Promise<null> {
    const watch = text(id, 'watch')
    const watching = this.watches.get(watch)
    if (watching === undefined) return null
    this.watches.delete(watch)
    try {
      await (await watching.stop)()
    } finally {
      watching.ended()
    }
    return null
  }

  /** End every watch, as the helper exits. */
  async unwatchAll(): Promise<void> {
    await Promise.allSettled([...this.watches.keys()].map(watch => this.unwatch({ watch })))
  }

  /** dsh's local file system, mounted on first use. */
  private fs(): Promise<FileSystem> {
    this.mounted ??= (async () => {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem, { cwd: this.cwd })
      return ctx.fs as FileSystem
    })()
    return this.mounted
  }
}

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
