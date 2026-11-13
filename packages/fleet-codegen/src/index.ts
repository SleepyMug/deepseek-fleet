/**
 * `@sleepymug/fleet-codegen`: a service's client, made from its schema
 * (./generate.ts), and what it imports, the clients' runtime.
 * @module @sleepymug/fleet-codegen
 */

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locate } from '@sleepymug/fleet-pack'
import { CLIENT_RUNTIME } from './generate.ts'

export { CLIENT_RUNTIME, generateClient, SchemaError, type ClientPlace, type ClientSpec, type GeneratedClient } from './generate.ts'

/** What a client imports, which the box needs beside it, with what it depends on: fleet-service-client, at the version its code is made for. */
export const RUNTIME = [CLIENT_RUNTIME] as const

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** Who makes the clients, so that a client made by another is another: this package's version, and fleet-service-client's. */
export const GENERATOR = (() => {
  const require = createRequire(import.meta.url)
  const own = require('../package.json') as { version: string }
  const runtime = require(`${CLIENT_RUNTIME}/package.json`) as { version: string }
  return `fleet-codegen ${own.version}, fleet-service-client ${runtime.version}`
})()

/** Where the runtime's packages are installed beside this one, for the gateway to stage. */
export async function runtimeRoots(): Promise<string[]> {
  return await Promise.all(RUNTIME.map(async (name) => {
    const dir = await locate(PACKAGE_DIR, name)
    if (dir === undefined) throw new Error(`fleet-codegen: ${name}, which the clients import, is not installed beside it`)
    return dir
  }))
}
