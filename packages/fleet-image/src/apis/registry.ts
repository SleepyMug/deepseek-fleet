/**
 * fleet's implementations of the APIs a tau may declare (tau's SPEC.md,
 * Implementations), the only ones fleet links: a session's agent gets the
 * implementation of the same name for each API it declares. Each is a module
 * of this folder, ./<name>/index.ts, compiled with its declarations beside
 * it, which the host checks the agent's API against as installed here, and
 * which the session image carries at {@link IMAGE_APIS}/<name>/index.js.
 * Some run in the program alone; others call backends of the fleet host
 * (./client.ts), and fleet runs an agent only when those are provided.
 * @module fleet-image/apis/registry
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PACKAGE_ROOT } from '../layout.ts'

/** Where the session image holds this folder of the package's lib/. */
export const IMAGE_APIS = `${PACKAGE_ROOT}/apis`

/** The backends each implementation calls, by the name of the API it implements. */
const BACKENDS: Readonly<Record<string, readonly string[]>> = {
  archives: ['archives'],
  notes: ['notes'],
  'text-stats': [],
}

/** An implementation, named after the API it implements. */
export interface Implementation {
  name: string
  /** Its declarations' package documentation. */
  description: string | undefined
  /** The fleet host's backends it calls, which must be provided for it to work. */
  backends: readonly string[]
  /** Its module as installed here, its declarations beside it: what tau's `checkImplementation` takes. */
  file: string
  /** Its module in a session's container. */
  image: string
}

/** Every implementation, by name. */
export function implementations(): Implementation[] {
  return Object.keys(BACKENDS).sort().map(name => implementation(name) as Implementation)
}

/** The implementation of the API `name`, if fleet has one. */
export function implementation(name: string): Implementation | undefined {
  const backends = Object.hasOwn(BACKENDS, name) ? BACKENDS[name] : undefined
  if (backends === undefined) return undefined
  const file = fileURLToPath(new URL(`./${name}/index.js`, import.meta.url))
  return { name, description: packageDescription(declarationsFile(file)), backends: [...backends], file, image: `${IMAGE_APIS}/${name}/index.js` }
}

/** An implementation's declarations: an API file for it, to copy into a tau's api/<name>.d.ts. */
export function declarations(implementation: Implementation): string {
  return readFileSync(declarationsFile(implementation.file), 'utf8')
}

function declarationsFile(file: string): string {
  return file.replace(/\.js$/u, '.d.ts')
}

/** The text of a declaration file's first doc comment, when it is the package's documentation, up to its first tag. */
function packageDescription(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  const comment = /^\s*\/\*\*([^]*?)\*\//u.exec(readFileSync(file, 'utf8'))?.[1]
  if (comment === undefined || !/@packageDocumentation\b/u.test(comment)) return undefined
  const lines = comment.split('\n').map(line => line.replace(/^\s*\* ?/u, '').trimEnd())
  const end = lines.findIndex(line => line.startsWith('@'))
  const text = (end === -1 ? lines : lines.slice(0, end)).join(' ').replace(/\s+/gu, ' ').trim()
  return text === '' ? undefined : text
}
