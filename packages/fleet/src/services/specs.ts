/**
 * The services' specs, as their servers stage them: a service's name, what
 * it is, its schema, the protobuf services it serves, its package, if it
 * has one, and what it adds to a box's environment. Staging checks the
 * spec, makes its client (fleet-codegen) and keeps both, the client in the
 * store, under the spec's digest, which a server's tunnel names; the same
 * spec staged again is the one already kept. Specs outlast the gateway, so
 * a server that comes back after the gateway restarts finds its own.
 * @module @sleepymug/fleet/services/specs
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { toBinary } from '@bufbuild/protobuf'
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError } from '@connectrpc/connect'
import { generateClient, GENERATOR, SchemaError } from '@sleepymug/fleet-codegen'
import type { StageServiceRequest } from '@sleepymug/fleet-protocol/fleet'
import { boxLayout, clientPackage, SERVICES_SOCKET_VARIABLE } from '@sleepymug/fleet-protocol/layout'
import { SERVICE_NAME, servicePath } from '@sleepymug/fleet-protocol/wire'
import type { Store } from '../store.ts'

/** A spec, as the gateway keeps it. */
export interface Spec {
  /** Its digest, which names it. */
  readonly digest: string
  readonly name: string
  readonly description: string
  /** The protobuf services it serves. */
  readonly services: readonly string[]
  /** The digest of its package, in the store once uploaded; empty for none. */
  readonly package: string
  readonly env: Readonly<Record<string, string>>
  /** The digest of its client, in the store. */
  readonly client: string
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const DIGEST = /^[0-9a-f]{64}$/u

export class Specs {
  private readonly known = new Map<string, Spec>()

  constructor(private readonly dir: string, private readonly store: Store) {}

  /** Check a spec, make its client, and keep both; the same spec staged again is the one kept. */
  async stage(request: StageServiceRequest): Promise<Spec> {
    const { name, description, schema, services, package: pkg, env } = request
    if (!SERVICE_NAME.test(name)) throw invalid(`${JSON.stringify(name)} is no service's name: lowercase letters, digits and hyphens, a letter first`)
    if (schema === undefined || schema.file.length === 0) throw invalid(`${name} has no schema`)
    if (services.length === 0) throw invalid(`${name} serves no protobuf service`)
    if (pkg !== '' && !DIGEST.test(pkg)) throw invalid(`${JSON.stringify(pkg)} is no package's digest`)
    for (const key of Object.keys(env)) if (!ENV_NAME.test(key)) throw invalid(`${JSON.stringify(key)} is no environment variable's name`)
    const sortedEnv = Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    const schemaBytes = toBinary(FileDescriptorSetSchema, schema)
    const digest = createHash('sha256')
      .update(JSON.stringify({ name, description, services, package: pkg, env: sortedEnv, generator: GENERATOR }))
      .update(schemaBytes)
      .digest('hex')
    const kept = await this.get(digest)
    if (kept !== undefined) return kept
    const layout = boxLayout()
    let client: string
    try {
      const made = generateClient({ name, description, schema, services }, {
        package: clientPackage(name),
        socket: layout.servicesSocket,
        socketVariable: SERVICES_SOCKET_VARIABLE,
        path: servicePath(name),
        dir: posix.join(layout.modules, clientPackage(name)),
      })
      client = await this.store.make(async (dir) => {
        for (const [path, content] of made.files) {
          await mkdir(dirname(join(dir, path)), { recursive: true })
          await writeFile(join(dir, path), content)
        }
      })
    } catch (error) {
      if (error instanceof SchemaError) throw invalid(error.message)
      throw error
    }
    const spec: Spec = { digest, name, description, services: [...services], package: pkg, env: sortedEnv, client }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeFile(join(this.dir, `${digest}.binpb`), schemaBytes)
    await writeFile(join(this.dir, `${digest}.json.new`), `${JSON.stringify(spec, null, 2)}\n`)
    await rename(join(this.dir, `${digest}.json.new`), join(this.dir, `${digest}.json`))
    this.known.set(digest, spec)
    return spec
  }

  /** The spec by its digest, staged now or before; undefined for one never staged. */
  async get(digest: string): Promise<Spec | undefined> {
    if (!DIGEST.test(digest)) return undefined
    const known = this.known.get(digest)
    if (known !== undefined) return known
    try {
      const spec = JSON.parse(await readFile(join(this.dir, `${digest}.json`), 'utf8')) as Spec
      // A spec kept by a gateway whose client is gone from the store is staged again.
      if (!(await this.store.has(spec.client))) return undefined
      this.known.set(digest, spec)
      return spec
    } catch {
      return undefined
    }
  }

  /** A spec's package's commands, each by its name, the path of its program in the package, as its `bin` says. */
  async commands(spec: Spec): Promise<Record<string, string>> {
    if (spec.package === '' || !(await this.store.has(spec.package))) return {}
    const manifest = JSON.parse(await readFile(join(this.store.path(spec.package), 'package.json'), 'utf8')) as { name?: string; bin?: string | Record<string, string> }
    const bin = typeof manifest.bin === 'string' ? { [(manifest.name ?? spec.name).replace(/^@[^/]+\//u, '')]: manifest.bin } : manifest.bin ?? {}
    const commands: Record<string, string> = {}
    for (const [command, path] of Object.entries(bin)) {
      const inside = posix.normalize(path).replace(/^\.\//u, '')
      if (command.includes('/') || inside.startsWith('../') || posix.isAbsolute(inside)) continue
      commands[command] = inside
    }
    return commands
  }
}

function invalid(message: string): ConnectError {
  return new ConnectError(`fleet: ${message}`, Code.InvalidArgument)
}
