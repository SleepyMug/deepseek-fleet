/**
 * What a root session's container gets beyond fleet-box's own: bind mounts,
 * copies, environment variables and folders that another plugin asks for,
 * such as fleet-tau's snapshot of the agent a `fleet run` started and the
 * paths its arguments name. They are kept in one file per session in the dsh
 * home, and the world reads that file itself each time it creates or starts
 * the container, so a container never loses them because the plugin that
 * asked is not loaded, or not loaded yet. The additions are part of the
 * container's spec: changing them recreates the container on its next use,
 * and a file that cannot be read fails the use instead of recreating the
 * container without them.
 * @module fleet-runtime/box/additions
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { z } from 'zod'

/** Folders of the container that fleet-box itself fills; no addition may cover them. */
const RESERVED = ['/opt/fleet-box', '/run/fleet-box']
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

/** A host path bind-mounted into the container. */
export interface Mount {
  /** Absolute host path. */
  source: string
  /** Absolute, normalized path in the container. */
  target: string
  readonly: boolean
}

/** A host path copied into the container. */
export interface Copy {
  /** Absolute host path: a file, or a folder with its files, folders and symlinks. */
  source: string
  /** Absolute, normalized path in the container, which the copy replaces. */
  target: string
}

/** What a root session's container gets beyond the session folder. */
export interface ContainerAdditions {
  mounts: Mount[]
  /**
   * Host paths copied into the container, through its helper, when it is
   * created, and again whenever it is recreated; from then on each copy is
   * the container's own. A copy may not overlap a mount or another copy.
   */
  copies?: Copy[]
  /** Variables every process in the container sees, the helper's and a terminal's included. */
  env?: Record<string, string>
  /** Folders made in the container, with their parents, whenever it starts; they are not part of its spec. */
  directories?: string[]
}

const containerPath = z.string().refine(path => posix.isAbsolute(path) && posix.normalize(path) === path && path !== '/' && !path.endsWith('/'),
  'must be an absolute, normalized path in the container, other than /')

const additionsSchema = z.object({
  mounts: z.array(z.object({
    source: z.string().refine(isAbsolute, 'must be an absolute host path'),
    target: containerPath,
    readonly: z.boolean(),
  }).strict()),
  copies: z.array(z.object({
    source: z.string().refine(isAbsolute, 'must be an absolute host path'),
    target: containerPath,
  }).strict()).optional(),
  env: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'must be a variable name').refine(name => !reservedVariable(name), 'is the container\'s own'),
    z.string().refine(value => !value.includes('\0'), 'must not hold a NUL'),
  ).optional(),
  directories: z.array(containerPath).optional(),
}).strict()

/** The file that holds a root session's additions. */
export function additionsFile(home: string, session: string): string {
  return join(home, 'fleet', 'containers', `${session}.json`)
}

/** The file that names the container a root session's copies went into last. */
function copiedFile(home: string, session: string): string {
  return join(home, 'fleet', 'containers', `${session}.copied`)
}

/** @returns the id of the container a root session's copies went into last, if any did. */
export async function readCopied(home: string, session: string): Promise<string | undefined> {
  return (await readFile(copiedFile(home, session), 'utf8').catch(() => '')).trim() || undefined
}

/** Record that a root session's copies are all in a container. */
export async function writeCopied(home: string, session: string, container: string): Promise<void> {
  await writeFile(copiedFile(home, session), `${container}\n`, { mode: 0o600 })
}

/**
 * A root session's additions.
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

/** Replace a root session's additions at once, readable only by the owner. */
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

/** Remove a root session's additions, if it has any. */
export async function removeAdditions(home: string, session: string): Promise<void> {
  await rm(additionsFile(home, session), { force: true })
  await rm(copiedFile(home, session), { force: true })
}

/**
 * The `docker run` arguments of a container's additions, none without any,
 * so a container without additions keeps its spec.
 * @param workspace - the session folder, which no addition may cover or lie in.
 * @throws when an addition would cover the session folder or fleet-box's own
 * folders, or a copy would overlap a mount, whose host files it would write,
 * or another copy.
 */
export function additionArgs(additions: ContainerAdditions | undefined, workspace: string): string[] {
  if (additions === undefined) return []
  const copies = additions.copies ?? []
  const targets = [...additions.mounts.map(({ target }) => ({ verb: 'mounts', target })), ...copies.map(({ target }) => ({ verb: 'copies to', target }))]
  for (const { verb, target } of targets) {
    for (const taken of [workspace, ...RESERVED]) {
      if (overlaps(target, taken)) throw new Error(`fleet-box: a container addition ${verb} ${target}, which overlaps ${taken}`)
    }
  }
  for (const [index, { target }] of copies.entries()) {
    for (const other of [...additions.mounts, ...copies.slice(index + 1)]) {
      if (overlaps(target, other.target)) throw new Error(`fleet-box: a container addition copies to ${target}, which overlaps ${other.target}`)
    }
  }
  const mounts = additions.mounts.flatMap(mount => [
    '--mount', `type=bind,${mountField(`src=${mount.source}`)},${mountField(`dst=${mount.target}`)}${mount.readonly ? ',readonly' : ''}`,
  ])
  const env = Object.entries(additions.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([name, value]) => ['--env', `${name}=${value}`])
  return [...mounts, ...env]
}

/** One field of a `--mount` value, which Docker parses as a CSV record; a plain path stays as it is, so its container's spec does too. */
export function mountField(field: string): string {
  return /[",\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field
}

/** Whether one container path is, or lies inside, the other. */
function overlaps(a: string, b: string): boolean {
  const [outer, inner] = a.length <= b.length ? [a, b] : [b, a]
  return outer === '/' || inner === outer || inner.startsWith(`${outer}/`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
