/**
 * What a box gets of its services, as one tree, which its helper installs
 * at the layout's `fleet` as the box first starts (fleet-protocol's
 * layout, `TREE`): each service's client, `@fleet/<name>`, and what the
 * clients import, in `node_modules`; each service's own package, if it
 * has one, in `services/<name>`, its commands linked in `bin`; and the
 * README, which says what the box has and how a program uses it. A box's
 * services are fixed when it is made, so its tree is too; its digest is
 * that of what it is made from.
 * @module @sleepymug/fleet/boxes/contents
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { GENERATOR } from '@sleepymug/fleet-codegen'
import { BOX_LAYOUT, clientPackage, TREE } from '@sleepymug/fleet-protocol/layout'
import { bytesEntry, linkEntry, treeEntries, writeTar, type WriteEntry } from '@sleepymug/fleet-pack'
import type { Spec, Specs } from '../services/specs.ts'
import type { Store } from '../store.ts'

/** A box's tree, to install. */
export interface Contents {
  readonly digest: string
  /** The tree as an archive. */
  archive(): AsyncIterable<Uint8Array>
}

export interface ContentsDeps {
  store: Store
  specs: Specs
  /** The digest of what the clients import, in the store, as a node_modules. */
  runtime: string
}

/** The tree of a box with `specs`. */
export async function contentsOf(specs: readonly Spec[], { store, specs: all, runtime }: ContentsDeps): Promise<Contents> {
  const commands = await Promise.all(specs.map(spec => all.bin(spec)))
  const digest = createHash('sha256')
    .update(JSON.stringify({ generator: GENERATOR, runtime, services: specs.map(spec => [spec.name, spec.client, spec.package, spec.commands]) }))
    .digest('hex')
  const readme = await readmeOf(specs, commands, store)
  async function* entries(): AsyncGenerator<WriteEntry> {
    yield bytesEntry(TREE.readme, readme)
    yield* treeEntries(store.path(runtime))
    for (const [index, spec] of specs.entries()) {
      yield* treeEntries(store.path(spec.client), posix.join(TREE.modules, clientPackage(spec.name)))
      if (spec.package === '') continue
      const programs = new Set(Object.values(commands[index] ?? {}))
      const at = posix.join(TREE.services, spec.name)
      for await (const entry of treeEntries(store.path(spec.package), at)) {
        // A command is made executable, whatever its mode where its server installed it.
        yield programs.has(posix.relative(at, entry.name)) && entry.type === 'file' ? { ...entry, mode: entry.mode | 0o111 } : entry
      }
      for (const [command, path] of Object.entries(commands[index] ?? {})) {
        yield linkEntry(posix.join(TREE.bin, command), posix.join('..', at, path))
      }
    }
  }
  return { digest, archive: () => writeTar(entries()) }
}

/** The box's README: what it has, and how a program uses it, each service's part as its client says it, then its commands, each with what its spec says it does. */
async function readmeOf(specs: readonly Spec[], commands: readonly Record<string, string>[], store: Store): Promise<string> {
  const layout = BOX_LAYOUT
  const lines = [
    '# This box\'s services',
    '',
    specs.length === 0
      ? 'This box has no services.'
      : `Each service is a node package, \`@fleet/<name>\`, in ${layout.modules}, whose \`index.d.ts\`, whole in one file, declares each of its methods, the plain objects each takes and gives, and what each means. Node finds those packages from a program below ${layout.fleet}: write one as \`${layout.fleet}/programs/<name>.mts\`, or \`.mjs\`, and run it with \`node\`. A program elsewhere links them into a \`node_modules\` above it first: \`mkdir -p node_modules && ln -s ${layout.modules}/@fleet node_modules/@fleet\`.`,
    '',
    `Every program in the box reaches the services on one socket, ${layout.servicesSocket}, which \`$FLEET_SERVICES_SOCKET\` names too.`,
  ]
  for (const [index, spec] of specs.entries()) {
    lines.push('', (await readFile(join(store.path(spec.client), 'README.md'), 'utf8')).trimEnd())
    const names = Object.keys(commands[index] ?? {}).sort()
    if (names.length > 0) {
      lines.push('', 'Its commands, on the PATH:', '')
      for (const name of names) {
        const does = spec.commands[name] ?? ''
        lines.push(`- \`${name}\`${does === '' ? '' : `: ${does}`}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}
