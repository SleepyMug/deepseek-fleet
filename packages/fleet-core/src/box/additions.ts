/**
 * What a session's container gets beyond fleet-box's own: copies,
 * environment variables and folders that another plugin asks for,
 * such as fleet-tau's snapshot of the agent a run started and the paths its
 * arguments name. They are kept in one file per session in the dsh
 * home, and the world reads that file itself each time it creates or starts
 * the container, so a container never loses them because the plugin that
 * asked is not loaded, or not loaded yet. The additions are part of the
 * container's spec: changing them recreates the container on its next use,
 * and a file that cannot be read fails the use instead of recreating the
 * container without them.
 * @module fleet-core/box/additions
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { z } from 'zod'

/**
 * Variables fleet-box itself sets in every container, or that the helper,
 * its Node and what they start rely on the image for; no addition may set
 * them, nor any `LD_` variable of the dynamic linker.
 */
const RESERVED_ENV = ['FLEET_SOCKET', 'PATH', 'HOME', 'NODE_OPTIONS', 'NODE_PATH']

/** Whether a variable is fleet-box's or the container's own, which no addition may set. */
export function reservedVariable(name: string): boolean {
  return RESERVED_ENV.includes(name) || name.startsWith('LD_')
}

/** A host path copied into the container. */
export interface Copy {
  /** Absolute host path: a file, or a folder with its files, folders and symlinks. */
  source: string
  /** Absolute, normalized path in the container, which the copy replaces. */
  target: string
}

/** What a session's container gets beyond fleet-box's own, the workspace dir's mount included. */
export interface ContainerAdditions {
  /**
   * Whether the session's folder is the container's own, which Docker makes
   * as its working folder, rather than the workspace dir mounted from the host:
   * so for a run started inside another container, and for a fork of one.
   */
  ownFolder?: boolean
  /**
   * Host paths copied into the container, through its helper, in order, when
   * it is created, and again whenever it is recreated, so a copy replaces
   * what one before it put at its target; from then on each copy is the
   * container's own.
   */
  copies?: Copy[]
  /** Variables every process in the container sees, the helper's and a terminal's included. */
  env?: Record<string, string>
  /** Folders made in the container, with their parents, whenever it starts, after its copies; they are not part of its spec. */
  directories?: string[]
}

const containerPath = z.string().refine(path => posix.isAbsolute(path) && posix.normalize(path) === path && path !== '/' && !path.endsWith('/'),
  'must be an absolute, normalized path in the container, other than /')

/** Keys it does not know are dropped, such as the mounts an older fleet-box made. */
const additionsSchema = z.object({
  ownFolder: z.boolean().optional(),
  copies: z.array(z.object({
    source: z.string().refine(isAbsolute, 'must be an absolute host path'),
    target: containerPath,
  }).strict()).optional(),
  env: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'must be a variable name').refine(name => !reservedVariable(name), 'is the container\'s own'),
    z.string().refine(value => !value.includes('\0'), 'must not hold a NUL'),
  ).optional(),
  directories: z.array(containerPath).optional(),
})

/** The file that holds a session's additions, which a subagent session has only when it owns a container. */
export function additionsFile(home: string, session: string): string {
  return join(home, 'fleet', 'containers', `${session}.json`)
}

/** The file that names the container a session's copies went into last. */
function copiedFile(home: string, session: string): string {
  return join(home, 'fleet', 'containers', `${session}.copied`)
}

/** @returns the id of the container a session's copies went into last, if any did. */
export async function readCopied(home: string, session: string): Promise<string | undefined> {
  return (await readFile(copiedFile(home, session), 'utf8').catch(() => '')).trim() || undefined
}

/** Record that a session's copies are all in a container. */
export async function writeCopied(home: string, session: string, container: string): Promise<void> {
  await writeFile(copiedFile(home, session), `${container}\n`, { mode: 0o600 })
}

/**
 * A session's additions.
 * @returns them, or undefined when the session has none.
 * @throws when the file exists but cannot be read or is not valid.
 */
export async function readAdditions(home: string, session: string): Promise<ContainerAdditions | undefined> {
  const file = additionsFile(home, session)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`fleet-box: cannot read the container additions of ${session} in ${file}: ${message(error)}`, { cause: error })
  }
  try {
    return additionsSchema.parse(JSON.parse(text))
  } catch (error) {
    throw new Error(`fleet-box: the container additions of ${session} in ${file} are not valid: ${message(error)}`, { cause: error })
  }
}

/**
 * A session's additions, read at once, for a caller that cannot wait.
 * @returns them, or undefined when the session has none, or its file cannot be read or is not valid.
 */
export function readAdditionsNow(home: string, session: string): ContainerAdditions | undefined {
  try {
    return additionsSchema.parse(JSON.parse(readFileSync(additionsFile(home, session), 'utf8')))
  } catch {
    return undefined
  }
}

/** Replace a session's additions at once, readable only by the owner. */
export async function writeAdditions(home: string, session: string, additions: ContainerAdditions): Promise<void> {
  const parsed = additionsSchema.parse(additions)
  const file = additionsFile(home, session)
  await mkdir(join(home, 'fleet', 'containers'), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Remove a session's additions, if it has any. */
export async function removeAdditions(home: string, session: string): Promise<void> {
  await rm(additionsFile(home, session), { force: true })
  await rm(copiedFile(home, session), { force: true })
}

/**
 * The `docker run` arguments of a container's additions, its variables, in
 * name order; none without any, so a container without additions keeps its
 * spec. Copies and folders are made through the helper once the container
 * runs, so they are not among them.
 */
export function additionArgs(additions: ContainerAdditions | undefined): string[] {
  return Object.entries(additions?.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([name, value]) => ['--env', `${name}=${value}`])
}

/** One field of a `--mount` value, which Docker parses as a CSV record; a plain path stays as it is, so its container's spec does too. */
export function mountField(field: string): string {
  return /[",\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
