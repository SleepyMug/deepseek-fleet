/**
 * A service's client, made from its schema, as the gateway puts it in each
 * box that has the service, `@fleet/<name>` in the box's node_modules:
 * - `index.d.ts` (./declarations.ts), whole in one file: one client for
 *   each of the protobuf services the service serves, named for it,
 *   `notes` for `notes.v1.Notes`, its methods taking and giving plain
 *   objects, and the types of those objects, each with its comments;
 * - `index.js`, which makes those clients with fleet-box-client from the
 *   schema, embedded, each calling the service through the box's services
 *   socket;
 * - `package.json` and `README.md`.
 * Nothing here reads or writes a file: the gateway puts the files where
 * they go.
 * @module @sleepymug/fleet-codegen/generate
 */

import { create, createFileRegistry, toBinary, type DescMethod, type DescService } from '@bufbuild/protobuf'
import { FileDescriptorSetSchema, type FileDescriptorSet } from '@bufbuild/protobuf/wkt'
import { safeIdentifier } from '@bufbuild/protoplugin'
import { comment, declarations } from './declarations.ts'

/** What the clients import. */
export const CLIENT_RUNTIME = '@sleepymug/fleet-box-client'

/** What a client is made from: a service's spec, as its server stages it. */
export interface ClientSpec {
  /** The service's name, which its calls' path and its client's package are named by. */
  name: string
  /** What it is, and how a box's programs use it. */
  description: string
  /** Its schema, with its comments, and every file it imports. */
  schema: FileDescriptorSet
  /** The protobuf services it serves, by their full names. */
  services: readonly string[]
}

/** Where the client finds the service in a box. */
export interface ClientPlace {
  /** The client's package name, `@fleet/<name>`. */
  package: string
  /** The socket the box's programs reach every service on, unless `$FLEET_SERVICES_SOCKET` names another. */
  socket: string
  /** The variable that names another socket. */
  socketVariable: string
  /** Where the service's calls go, `/services/<name>`. */
  path: string
  /** Where the client is in the box, for the README to say. */
  dir: string
}

/** A client made. */
export interface GeneratedClient {
  /** Each file, by its path in the client's package. */
  files: ReadonlyMap<string, string>
  /** The service's part of the box's README, in Markdown. */
  readme: string
}

/** A schema that does not make a client: a file it imports missing, a service it names not in it. */
export class SchemaError extends Error {}

/** Make a service's client. */
export function generateClient(spec: ClientSpec, place: ClientPlace): GeneratedClient {
  let registry
  try {
    registry = createFileRegistry(spec.schema)
  } catch (error) {
    throw new SchemaError(`the schema of ${spec.name} is not whole: ${error instanceof Error ? error.message : String(error)}`)
  }
  const services = spec.services.map((name) => {
    const service = registry.getService(name)
    if (service === undefined) throw new SchemaError(`the schema of ${spec.name} has no service ${name}`)
    return service
  })
  if (services.length === 0) throw new SchemaError(`${spec.name} serves no protobuf service`)
  const names = clientNames(services)
  const out = new Map<string, string>()
  out.set('index.d.ts', declarations({ package: place.package, name: spec.name, description: spec.description }, services, names))
  out.set('index.js', script(spec, services, names, place))
  out.set('package.json', `${JSON.stringify({
    name: place.package,
    version: '0.0.0',
    description: spec.description,
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }, null, 2)}\n`)
  const readme = section(spec, services, names, place)
  out.set('README.md', readme)
  return { files: out, readme }
}

/** `index.js`: the clients, made from the schema, embedded without its comments, which the declarations carry. */
function script(spec: ClientSpec, services: readonly DescService[], names: ReadonlyMap<string, string>, place: ClientPlace): string {
  const schema = create(FileDescriptorSetSchema, { file: spec.schema.file.map(file => ({ ...file, sourceCodeInfo: undefined })) })
  const where = { path: place.path, socket: place.socket, socketVariable: place.socketVariable }
  return [
    `// ${place.package}, made by fleet's gateway from the ${spec.name} service's schema:`,
    '// index.d.ts says what each method takes and gives.',
    `import { schema, serviceClient } from '${CLIENT_RUNTIME}'`,
    '',
    `const types = schema('${Buffer.from(toBinary(FileDescriptorSetSchema, schema)).toString('base64')}')`,
    `const place = ${JSON.stringify(where)}`,
    '',
    ...services.map(service => `export const ${names.get(service.typeName) as string} = serviceClient(types, '${service.typeName}', place)`),
    '',
  ].join('\n')
}

/** Each service's client's name: its own, in lower camel case, or, where two services share it, its package's with it. */
function clientNames(services: readonly DescService[]): Map<string, string> {
  const camel = (words: string): string => words.replace(/^[A-Z]/u, letter => letter.toLowerCase())
  const counts = new Map<string, number>()
  for (const service of services) counts.set(service.name, (counts.get(service.name) ?? 0) + 1)
  return new Map(services.map((service) => {
    const name = (counts.get(service.name) ?? 0) > 1
      ? camel(service.typeName.split('.').map(part => part.replace(/^[a-z]/u, letter => letter.toUpperCase())).join(''))
      : camel(service.name)
    return [service.typeName, safeIdentifier(name)]
  }))
}

/** The service's part of the box's README. */
function section(spec: ClientSpec, services: readonly DescService[], names: ReadonlyMap<string, string>, place: ClientPlace): string {
  const lines = [
    `## ${spec.name}`,
    '',
    spec.description,
    '',
    '```js',
    `import { ${services.map(service => names.get(service.typeName)).join(', ')} } from '${place.package}'`,
    '```',
    '',
    `Its methods, their messages and what they mean: ${place.dir}/index.d.ts.`,
  ]
  for (const service of services) {
    const name = names.get(service.typeName) as string
    lines.push('', `### \`${name}\`: ${service.typeName}`)
    const about = paragraphs(service)
    if (about !== '') lines.push('', about)
    lines.push('')
    for (const method of service.methods) {
      const doc = paragraphs(method).split('\n')[0] ?? ''
      lines.push(`- \`${name}.${method.localName}(request)\`, ${shape(method)}${doc === '' ? '' : `: ${doc}`}`)
    }
  }
  const unary = services.flatMap(service => service.methods.filter(method => method.methodKind === 'unary').map(method => ({ service, method })))
  if (unary.length > 0) {
    const { service, method } = unary[0] as { service: DescService; method: DescMethod }
    lines.push(
      '',
      'A shell calls a method that answers once with its request as JSON, as protobuf maps it: its fields in lower camel case, bytes in base64, 64-bit integers as strings, and dates as RFC 3339:',
      '',
      '```sh',
      `curl -s --unix-socket ${place.socket} -H 'content-type: application/json' -d '{}' http://fleet${place.path}/${service.typeName}/${method.name}`,
      '```',
    )
  }
  return `${lines.join('\n')}\n`
}

function shape(method: DescMethod): string {
  switch (method.methodKind) {
    case 'unary': return `answers a \`${method.output.name}\``
    case 'server_streaming': return `answers a stream of \`${method.output.name}\``
    case 'client_streaming': return `takes a stream of \`${method.input.name}\`, answers a \`${method.output.name}\``
    case 'bidi_streaming': return `takes a stream of \`${method.input.name}\`, answers a stream of \`${method.output.name}\``
  }
}

/** A comment as Markdown paragraphs: its lines joined, its blank lines kept. */
function paragraphs(desc: DescService | DescMethod): string {
  return comment(desc).replace(/([^\n])\n(?!\n)/gu, '$1 ')
}
