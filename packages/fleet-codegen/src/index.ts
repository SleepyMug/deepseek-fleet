/**
 * `@sleepymug/fleet-codegen`: a service's client, made from its schema
 * (./generate.ts), and what it imports, the clients' runtime.
 * @module @sleepymug/fleet-codegen
 */

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locate } from '@sleepymug/fleet-pack'

export { generateClient, SchemaError, type ClientPlace, type ClientSpec, type GeneratedClient } from './generate.ts'

/** What a client imports, which the box needs beside it: the packages this one depends on, at the versions its code is made for. */
export const RUNTIME = ['@bufbuild/protobuf', '@connectrpc/connect', '@connectrpc/connect-node'] as const

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** Who makes the clients, so that a client made by another is another: this package's version, and protoc-gen-es's. */
export const GENERATOR = (() => {
  const require = createRequire(import.meta.url)
  const own = require('../package.json') as { version: string }
  const es = require('@bufbuild/protoc-gen-es/package.json') as { version: string }
  return `fleet-codegen ${own.version}, protoc-gen-es ${es.version}`
})()

/** Where the runtime's packages are installed beside this one, for the gateway to stage. */
export async function runtimeRoots(): Promise<string[]> {
  return await Promise.all(RUNTIME.map(async (name) => {
    const dir = await locate(PACKAGE_DIR, name)
    if (dir === undefined) throw new Error(`fleet-codegen: ${name}, which the clients import, is not installed beside it`)
    return dir
  }))
}
