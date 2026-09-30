/**
 * A service's binding: the package programs and modules in a session
 * container import as `@svc/<name>`, which fleet-tau's store writes into
 * the agent's snapshot where tau's SPEC.md has a runtime put it, at
 * modules/node_modules/@svc/<name>, so that modules find it as programs do.
 * It is typed by the agent's manifest as written, and each function calls
 * the service from the importing process (./service.ts). Plain data, so the
 * host writes it without loading tau's library.
 * @module fleet-tau-runner/binding
 */

import { pathToFileURL } from 'node:url'
import { SERVICE_CLIENT } from './protocol.ts'

/** A service as the agent declares it. */
export interface BoundService {
  name: string
  description?: string
  /** The manifest as written. */
  declarations: string
  /** The functions the agent declares, which are all the binding exports. */
  functions: readonly string[]
  /** The manifest's canonical JSON Schema, as tau gives it (`Service.schema`). */
  schema: unknown
}

/**
 * The files of a service's binding, by name.
 * @param client - where the binding finds ./service.ts compiled: {@link SERVICE_CLIENT} in a session container.
 */
export function serviceBinding(service: BoundService, client = SERVICE_CLIENT): Record<string, string> {
  const manifest = {
    name: `@svc/${service.name}`,
    ...service.description === undefined ? {} : { description: service.description },
    private: true,
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }
  const functions = service.functions.map(fn => `export function ${fn}(...args) {\n  return call(${JSON.stringify(fn)}, args)\n}\n`)
  const code = [
    `// The service ${service.name}, as the agent declares it, called through $TAU_SOCKET (fleet-tau-runner's binding.ts).\n`,
    `import { bindService } from ${JSON.stringify(pathToFileURL(client).href)}\n\n`,
    `const call = bindService(${JSON.stringify(service.schema)})\n\n`,
    functions.join('\n'),
  ]
  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'index.d.ts': service.declarations,
    'index.js': code.join(''),
  }
}
