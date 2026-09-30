/**
 * The packages that link the agent's APIs to fleet's implementations, as
 * pi-run links a tau's: each API becomes a package that programs import as
 * `@api/<name>`, whose types are the agent's `api/<name>.d.ts`, through a
 * symlink to its api/ folder so that their imports resolve there, and whose
 * code re-exports the implementation, whose own imports resolve from where
 * it is. A container's runs share the packages: each is written once, under
 * a name its content decides, and moved into place whole, so runs at the
 * same time never see one half-written.
 * @module fleet-tau-runner/links
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LinkedApi } from './protocol.ts'

/** How programs import an API (tau's SPEC.md). */
export const API_SCOPE = '@api/'

/**
 * The package of one API under `root`, written unless a run wrote it already.
 * @returns its folder.
 */
export async function linkApi(root: string, api: LinkedApi): Promise<string> {
  const manifest = {
    name: `${API_SCOPE}${api.name}`,
    ...api.description === undefined ? {} : { description: api.description },
    private: true,
    type: 'module',
    exports: { '.': { types: `./api/${api.name}.d.ts`, default: './index.js' } },
  }
  const url = JSON.stringify(pathToFileURL(api.implementation).href)
  // `export *` leaves out the default export, which the API may declare.
  const code = [`export * from ${url};`, `import * as implementation from ${url};`, 'export default implementation.default;', '']
  const files = { 'package.json': `${JSON.stringify(manifest, null, 2)}\n`, 'index.js': code.join('\n') }
  const key = createHash('sha256').update(JSON.stringify([api.types, files])).digest('hex').slice(0, 16)
  const folder = join(root, 'apis', `${api.name}-${key}`)
  if (await exists(folder)) return folder
  await mkdir(join(root, 'apis'), { recursive: true })
  const staging = await mkdtemp(join(root, 'apis', '.link-'))
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(staging, name), text)
    await symlink(dirname(api.types), join(staging, 'api'))
    await rename(staging, folder)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    // Another run moved the same package into place first.
    if (await exists(folder)) return folder
    throw error
  }
  return folder
}

/**
 * Programs are checked against the Node.js types tau checks APIs against:
 * this package's `@types/node`, linked under `root`, where ts-executor looks
 * for types before its own.
 */
export async function linkNodeTypes(root: string): Promise<void> {
  const link = join(root, 'node_modules', '@types', 'node')
  const target = dirname(createRequire(import.meta.url).resolve('@types/node/package.json'))
  if (await exists(link)) return
  await mkdir(dirname(link), { recursive: true })
  const staging = `${link}.${process.pid}`
  await symlink(target, staging)
  // Renaming one symlink over another is atomic, whichever run gets there first.
  await rename(staging, link)
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}
