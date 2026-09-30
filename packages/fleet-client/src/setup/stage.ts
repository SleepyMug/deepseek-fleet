/**
 * A package as installed, copied into an image's build context (adapted from
 * fyona's image-context.ts): the package, then every package it depends on,
 * each the instance Node finds from the package that depends on it, as
 * installed on this machine by whatever laid them out (this workspace, pnpm
 * or npm). The copy takes pnpm's layout, which holds several versions of a
 * name without hoisting, and in which a package reaches only what it
 * declares. Nothing is installed or compiled for the image, so it runs what
 * the host runs; since the package manager chose the platform-specific
 * packages for this machine, the image must be linux on its architecture.
 * @module fleet-client/setup/stage
 */

import { cp, mkdir, readdir, readFile, realpath, stat, symlink } from 'node:fs/promises'
import { basename, dirname, join, matchesGlob, posix, relative, sep } from 'node:path'

/** What staging reads of a package.json. */
interface Manifest {
  name?: string
  version?: string
  files?: string[]
  main?: string
  bin?: string | Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

/** An installed package: its real folder, and what its dependencies resolve to from there. */
interface Installed {
  dir: string
  name: string
  version: string
  manifest: Manifest
  /** By the name the package imports them under. */
  dependencies: Map<string, Installed>
}

/**
 * Find package `name` the way Node finds it from `from`.
 * @returns its real folder.
 */
export async function installedPackage(from: string, name: string): Promise<string> {
  const dir = await locate(await realpath(from), name)
  if (dir === undefined) throw new Error(`fleet: ${name} is not installed where ${from} can find it`)
  return dir
}

/**
 * Copy the package at `root` to `target`, and every package it depends on,
 * as installed, to `target`/node_modules.
 * @param arch - the image's architecture, in Node's naming.
 */
export async function stagePackage(root: string, target: string, arch: string): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new Error(`fleet: the packages are installed for ${process.platform}-${process.arch}, and the image is linux-${arch}: build it on linux-${arch}`)
  }
  await layOut(await installedClosure(await realpath(root), arch), target)
}

/**
 * The package at `root`, then everything its dependencies resolve to,
 * breadth first. Each dependency is looked up the way Node looks it up from
 * the depending package's real folder, so it is the instance that package
 * gets where it is installed, whatever the layout. As a package manager
 * would for the image's platform, an optional dependency that is missing or
 * not for that platform is left out.
 */
async function installedClosure(root: string, arch: string): Promise<Installed[]> {
  const packages: Installed[] = []
  const byDir = new Map<string, Installed>()
  const load = async (dir: string, optional: boolean): Promise<Installed | undefined> => {
    const known = byDir.get(dir)
    if (known !== undefined) return known
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest
    const { name, version } = manifest
    if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`fleet: ${join(dir, 'package.json')} has no name or version`)
    if (!allows(manifest.os, 'linux') || !allows(manifest.cpu, arch) || !allows(manifest.libc, 'glibc')) {
      if (optional) return undefined
      throw new Error(`fleet: ${name}@${version} is not for the image's platform, linux-${arch} with glibc`)
    }
    const installed: Installed = { dir, name, version, manifest, dependencies: new Map() }
    byDir.set(dir, installed)
    packages.push(installed)
    return installed
  }
  await load(root, false)
  // `packages` grows while it is walked.
  for (const pkg of packages) {
    const { dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta } = pkg.manifest
    const names = new Set([...Object.keys(dependencies ?? {}), ...Object.keys(optionalDependencies ?? {}), ...Object.keys(peerDependencies ?? {})])
    for (const name of names) {
      const optional = optionalDependencies?.[name] !== undefined || peerDependenciesMeta?.[name]?.optional === true
      const dir = await locate(pkg.dir, name)
      if (dir === undefined && !optional) throw new Error(`fleet: ${pkg.name}@${pkg.version} depends on ${name}, which is not installed where it can find it`)
      const dependency = dir === undefined ? undefined : await load(dir, optional)
      if (dependency !== undefined) pkg.dependencies.set(name, dependency)
    }
  }
  return packages
}

/** Where Node finds package `name` from `dir`: the first `node_modules/<name>` walking up, as a real path. */
async function locate(dir: string, name: string): Promise<string | undefined> {
  for (let at = dir; ; at = dirname(at)) {
    if (basename(at) !== 'node_modules') {
      const candidate = join(at, 'node_modules', name)
      if (await stat(candidate).then(info => info.isDirectory(), () => false)) return realpath(candidate)
    }
    if (dirname(at) === at) return undefined
  }
}

/** npm's `os`/`cpu`/`libc` rule: `!x` excludes x, and any other entry makes the list exclusive. */
function allows(list: string[] | undefined, value: string): boolean {
  if (list === undefined) return true
  if (list.includes(`!${value}`)) return false
  return list.includes(value) || list.every(entry => entry.startsWith('!'))
}

/**
 * pnpm's layout: the first package at `target`, every other one once at
 * `node_modules/.store/<name>@<version>/node_modules/<name>`, and each
 * package's dependencies as relative links in the node_modules that holds
 * it. Node resolves from a package's real path, so every package gets
 * exactly the dependency instances it had where installed, however many
 * versions of a name there are, and nothing it did not declare.
 */
async function layOut(packages: readonly Installed[], target: string): Promise<void> {
  const places = new Map<Installed, { dir: string; modules: string }>()
  const keys = new Set<string>()
  for (const pkg of packages) {
    if (places.size === 0) {
      places.set(pkg, { dir: target, modules: join(target, 'node_modules') })
      continue
    }
    const base = `${pkg.name.replace('/', '+')}@${pkg.version}`
    let key = base
    for (let n = 2; keys.has(key); n++) key = `${base}_${n}`
    keys.add(key)
    const modules = join(target, 'node_modules', '.store', key, 'node_modules')
    places.set(pkg, { dir: join(modules, pkg.name), modules })
  }
  const placeOf = (pkg: Installed): { dir: string; modules: string } => places.get(pkg) as { dir: string; modules: string }
  for (const pkg of packages) {
    const { dir, modules } = placeOf(pkg)
    await copyPackage(pkg, dir)
    for (const [name, dependency] of pkg.dependencies) {
      const link = join(modules, name)
      if (link === dir) {
        // Where the package itself is: right only if it is the package itself.
        if (dependency === pkg) continue
        throw new Error(`fleet: ${pkg.name}@${pkg.version} depends on another ${name}, which this layout cannot hold`)
      }
      await mkdir(dirname(link), { recursive: true })
      await symlink(relative(dirname(link), placeOf(dependency).dir), link)
    }
  }
}

/** Files `pnpm pack` always takes from a package's root, besides package.json: any case, any extension. */
const ALWAYS_PACKED = /^(?:readme|licen[cs]e)(?:\..*)?$/iu

/**
 * An installed package (one inside a node_modules) was packed when it was
 * installed, and is copied as it is, without the packages installed inside
 * it. A source tree (a workspace or linked package) is copied as `pnpm pack`
 * would pack it, so a package linked with `link:` lands in the image as it
 * would installed with `file:`:
 * - package.json, README and LICENSE files at the root, and the `main` and
 *   `bin` files;
 * - its `files`, which must be plain paths, less those a `!` pattern in
 *   `files` excludes;
 * - files only, so no empty folders.
 * Stray files pnpm would drop (`.DS_Store`, lockfiles, …) are copied; none
 * occur in what `fleet setup image` copies.
 */
async function copyPackage(pkg: Installed, to: string): Promise<void> {
  if (pkg.dir.split(sep).includes('node_modules')) {
    const nested = join(pkg.dir, 'node_modules')
    await cp(pkg.dir, to, { recursive: true, dereference: true, filter: source => source !== nested })
    return
  }
  const { files, main, bin } = pkg.manifest
  if (files === undefined) throw new Error(`fleet: ${pkg.name} at ${pkg.dir} is a source tree without "files", so what it publishes is unknown`)
  const always = (await readdir(pkg.dir)).filter(name => ALWAYS_PACKED.test(name))
  const entrypoints = [...main === undefined ? [] : [main], ...typeof bin === 'string' ? [bin] : Object.values(bin ?? {})]
  for (const entry of ['package.json', ...always, ...entrypoints]) {
    const source = join(pkg.dir, entry)
    if (await exists(source)) await copyPacked(source, join(to, entry), entry, [])
  }
  const excluded = files.filter(entry => entry.startsWith('!')).map(entry => entry.slice(1))
  for (const entry of files.filter(entry => !entry.startsWith('!'))) {
    if (/[*?[\]{}]/u.test(entry)) throw new Error(`fleet: ${pkg.name}: "files" entry ${entry} is a pattern; only plain paths, and patterns that exclude, are supported`)
    const source = join(pkg.dir, entry)
    if (!(await exists(source))) throw new Error(`fleet: ${pkg.name}: ${entry}, listed in its "files", does not exist; build the package first`)
    await copyPacked(source, join(to, entry), posix.normalize(entry), excluded)
  }
}

/**
 * Copy the files under `source`, or `source` itself; folders are made only for files.
 * @param path - `source` relative to its package, which `excluded` patterns match.
 */
async function copyPacked(source: string, target: string, path: string, excluded: readonly string[]): Promise<void> {
  if (!(await stat(source)).isDirectory()) {
    if (excluded.some(pattern => matchesGlob(path, pattern))) return
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { dereference: true })
    return
  }
  for (const name of await readdir(source)) {
    await copyPacked(join(source, name), join(target, name), posix.join(path, name), excluded)
  }
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}
