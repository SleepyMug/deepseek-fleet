/**
 * What a root session's container gets beyond fleet-box's own: bind mounts,
 * environment variables and folders that another plugin asks for, such as
 * fleet-tau's snapshot of the agent a `fleet run` started and the paths its
 * arguments name. They are kept in one file per session in the dsh
 * home, and the world reads that file itself each time it creates or starts
 * the container, so a container never loses them because the plugin that
 * asked is not loaded, or not loaded yet. The additions are part of the
 * container's spec: changing them recreates the container on its next use,
 * and a file that cannot be read fails the use instead of recreating the
 * container without them.
 * @module fleet-box/additions
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { z } from 'zod'

/** Folders of the container that fleet-box itself fills; no addition may cover them. */
const RESERVED = ['/opt/fleet-box', '/run/fleet-box']
/** Variables fleet-box itself sets in every container; no addition may set them. */
const RESERVED_ENV = ['TAU_SOCKET']

/** A host path bind-mounted into the container. */
export interface Mount {
  /** Absolute host path. */
  source: string
  /** Absolute, normalized path in the container. */
  target: string
  readonly: boolean
}

/** What a root session's container gets beyond the session folder. */
export interface ContainerAdditions {
  mounts: Mount[]
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
  env: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'must be a variable name').refine(name => !RESERVED_ENV.includes(name), 'is set by fleet-box itself'),
    z.string().refine(value => !value.includes('\0'), 'must not hold a NUL'),
  ).optional(),
  directories: z.array(containerPath).optional(),
}).strict()

/** The file that holds a root session's additions. */
export function additionsFile(home: string, session: string): string {
  return join(home, 'fleet', 'containers', `${session}.json`)
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
}

/**
 * The `docker run` arguments of a container's additions, none without any,
 * so a container without additions keeps its spec.
 * @param workspace - the session folder, which no addition may cover or lie in.
 * @throws when an addition would cover the session folder or fleet-box's own folders.
 */
export function additionArgs(additions: ContainerAdditions | undefined, workspace: string): string[] {
  if (additions === undefined) return []
  for (const { target } of additions.mounts) {
    for (const taken of [workspace, ...RESERVED]) {
      if (overlaps(target, taken)) throw new Error(`fleet-box: a container addition mounts ${target}, which overlaps ${taken}`)
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
