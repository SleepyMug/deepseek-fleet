/**
 * The install of the dsh on the PATH, where a dsh profile's packages find
 * the peers the profile leaves to dsh. dsh resolves a package the profile
 * does not install from its own install instead, so a profile holds none
 * of them. npm installs the command `dsh` as a link to the bin in dsh's
 * package; pnpm as a shell shim whose last line names that bin.
 * @module @sleepymug/fleet-box-runtime/image/dsh
 */

import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { locate } from './stage.ts'

/** dsh's package. */
const DSH = '@deepseek-ai/dsh'

/** The last line of pnpm's shim: the bin it runs, relative to the shim's real folder. */
const SHIM_TARGET = /^# cmd-shim-target=(.+)$/mu

/**
 * The packages the install of the first `dsh` on `path` gives a profile,
 * each by name, at its real path, as dsh collects them: its package, then
 * what each depends on, and has as a peer, breadth first, the first found
 * of each name. None for no `dsh` there, or one that is neither npm's link
 * nor pnpm's shim.
 */
export async function dshPackages(path = process.env.PATH ?? ''): Promise<Map<string, string> | undefined> {
  const dir = await findDsh(path)
  if (dir === undefined) return undefined
  const packages = new Map([[DSH, dir]])
  // `queue` grows while it is walked.
  const queue = [dir]
  for (const at of queue) {
    const { dependencies, peerDependencies } = JSON.parse(await readFile(join(at, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    for (const name of [...Object.keys(dependencies ?? {}), ...Object.keys(peerDependencies ?? {})]) {
      if (packages.has(name)) continue
      const found = await locate(at, name)
      if (found === undefined) continue
      packages.set(name, found)
      queue.push(found)
    }
  }
  return packages
}

/** The real folder of the package of the first `dsh` on `path`. */
async function findDsh(path: string): Promise<string | undefined> {
  for (const folder of path.split(delimiter)) {
    if (folder === '') continue
    const command = join(folder, 'dsh')
    if (!(await access(command, constants.X_OK).then(() => true, () => false))) continue
    const real = await realpath(command)
    return await packageOf(real) ?? await packageOf(await shimTarget(real))
  }
  return undefined
}

/** The bin a pnpm shim runs, as a real path; none for a file that is no shim. */
async function shimTarget(shim: string): Promise<string | undefined> {
  // A shim is a short script; anything larger is a program of its own.
  if ((await stat(shim)).size > 64 * 1024) return undefined
  const target = SHIM_TARGET.exec(await readFile(shim, 'utf8'))?.[1]
  return target === undefined ? undefined : realpath(resolve(dirname(shim), target)).catch(() => undefined)
}

/** The folder of dsh's package, if `file` is in it: the first folder above it with a package.json that has a name. */
async function packageOf(file: string | undefined): Promise<string | undefined> {
  if (file === undefined) return undefined
  for (let at = dirname(file); dirname(at) !== at; at = dirname(at)) {
    let name: unknown
    try {
      name = (JSON.parse(await readFile(join(at, 'package.json'), 'utf8')) as { name?: unknown }).name
    } catch {
      continue
    }
    if (name !== undefined) return name === DSH ? at : undefined
  }
  return undefined
}
