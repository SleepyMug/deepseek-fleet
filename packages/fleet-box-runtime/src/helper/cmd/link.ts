/**
 * `apis.link`: the node_modules folder where a tau's code finds its APIs
 * (tau's docs/spec/implementations.md). Each API becomes a package by its
 * contract's name, whose types are its contract's declarations, as the
 * extension that implements it has them, through a link to their folder,
 * so that their imports resolve there, and whose code re-exports the client
 * of that extension, so that every import in a process gets that one
 * module. Each exposed package of the tau's own is linked by its name, and
 * this package by its own, whose client runtime the extensions' clients
 * import (../../ext/client.ts). Node looks for a package in every folder
 * above the file that imports it, so a program anywhere below the folder
 * holding `modules`, and the tau's own packages, find them, and TypeScript
 * does too.
 * @module @sleepymug/fleet-box-runtime/helper/cmd/link
 */

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PACKAGE_NAME, PACKAGE_ROOT } from '../../layout.ts'
import type { Methods } from '../protocol.ts'

type Params = Methods['apis.link']['params']

/** What each part of a package's name may be. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export async function apisLink(params: Params): Promise<null> {
  const { modules, apis, packages } = checked(params)
  for (const { name, client, types } of apis) {
    const folder = join(modules, name)
    await rm(folder, { recursive: true, force: true })
    await mkdir(folder, { recursive: true })
    const manifest = {
      name,
      private: true,
      type: 'module',
      exports: { '.': { types: './contract/index.d.ts', default: './index.js' } },
    }
    const url = JSON.stringify(pathToFileURL(join(client, 'index.js')).href)
    // `export *` leaves out the default export, which the API may declare.
    const code = [`export * from ${url};`, `import * as implementation from ${url};`, 'export default implementation.default;', '']
    await writeFile(join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(folder, 'index.js'), code.join('\n'))
    await symlink(types, join(folder, 'contract'))
  }
  for (const { name, dir } of [...packages, { name: PACKAGE_NAME, dir: PACKAGE_ROOT }]) {
    const link = join(modules, name)
    await mkdir(dirname(link), { recursive: true })
    await rm(link, { recursive: true, force: true })
    await symlink(dir, link)
  }
  return null
}

function checked(params: Params): Params {
  const { modules, apis, packages } = (params ?? {}) as Partial<Params>
  if (typeof modules !== 'string' || !isAbsolute(modules)) throw new TypeError('apis.link takes modules, an absolute path')
  const absolute = (value: unknown): boolean => typeof value === 'string' && isAbsolute(value)
  const packageName = (name: unknown): boolean => typeof name === 'string'
    && (name.startsWith('@') ? name.slice(1).split('/') : [name]).every(part => NAME.test(part))
    && name.split('/').length === (name.startsWith('@') ? 2 : 1) && name !== PACKAGE_NAME
  if (!Array.isArray(apis) || !apis.every(api => packageName(api?.name) && absolute(api.client) && absolute(api.types))) {
    throw new TypeError(`apis.link takes apis, a list of { name, client, types }, each a contract's name, not ${PACKAGE_NAME}, and two absolute paths`)
  }
  const names = new Set(apis.map(api => api.name))
  if (!Array.isArray(packages) || !packages.every(entry => packageName(entry?.name) && !names.has(entry.name) && absolute(entry?.dir))) {
    throw new TypeError(`apis.link takes packages, a list of { name, dir }, each a package name, none an API's or ${PACKAGE_NAME}, and an absolute path`)
  }
  return { modules, apis, packages }
}
