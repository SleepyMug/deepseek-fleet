/**
 * `ctx.fs` for the fleet execution world: every call runs in the container of
 * the session whose agent made it, through that session's dsh-ssh helper. A
 * call outside any session's work, like a sidebar view or a file link, fails
 * instead of reading the host. The world does not confine file access itself,
 * since the container is the boundary, so `sandboxMode` stays unset and the
 * file tools offer no sandbox escalation.
 * @module fleet-box/fs
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './world.ts'

export class FleetBoxFileSystem extends FileSystem {
  static inject = ['fleetBox', 'sandboxPolicy']

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return (await this.world('ctx.fs.resolve')).resolve(path, opts)
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
    return (await this.world('ctx.fs.stat')).stat(target, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return (await this.world('ctx.fs.lstat')).lstat(path, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return (await this.world('ctx.fs.readText')).readText(target, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return (await this.world('ctx.fs.streamText')).streamText(target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return (await this.world('ctx.fs.readBytes')).readBytes(target, signal, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.world('ctx.fs.readByteRange')).readByteRange(target, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return (await this.world('ctx.fs.listDir')).listDir(target, signal)
  }

  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const { agent, world } = await this.ctx.fleetBox.current('ctx.fs.writeText')
    return world.fs.writeText(target, content, expected, signal, sandboxPolicy ?? this.policy(agent))
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const { agent, world } = await this.ctx.fleetBox.current('ctx.fs.editText')
    return world.fs.editText(target, edit, expected, signal, sandboxPolicy ?? this.policy(agent))
  }

  private async world(operation: string): Promise<FileSystem> {
    return (await this.ctx.fleetBox.current(operation)).world.fs
  }

  /**
   * The session's own policy for a mutation that brings none. The helper
   * resolves its workspace root in the container, where the session folder
   * exists but the host process's default root may not.
   */
  private policy(agent: Agent): SandboxExecutionPolicy {
    return this.ctx.sandboxPolicy.resolve({ session: agent.session })
  }
}

export default FleetBoxFileSystem
