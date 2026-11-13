/**
 * A service's client, made from its schema, as the gateway puts it in each
 * box that has the service, `@fleet/<name>` in the box's node_modules:
 * - each file of the schema, as protoc-gen-es writes it for JavaScript with
 *   its declarations, the comments as JSDoc, but the well-known types,
 *   which the runtime has;
 * - `index.js` and `index.d.ts`, which export one client for each of the
 *   protobuf services the service serves, named for it, `notes` for
 *   `notes.v1.Notes`, its methods declared one by one with their comments,
 *   so that whoever writes a program reads them there; each calls the
 *   service through the box's services socket;
 * - `package.json` and `README.md`.
 * Nothing here reads or writes a file: the gateway puts the files where
 * they go.
 * @module @sleepymug/fleet-codegen/generate
 */

import { createRequire } from 'node:module'
import { create, createFileRegistry, type DescFile, type DescMethod, type DescService } from '@bufbuild/protobuf'
import { CodeGeneratorRequestSchema, type FileDescriptorProto, type FileDescriptorSet } from '@bufbuild/protobuf/wkt'
import { createEcmaScriptPlugin, getComments, safeIdentifier, type GeneratedFile, type Plugin, type Schema } from '@bufbuild/protoplugin'

/** protoc-gen-es, run here rather than as protoc's plugin. */
const { protocGenEs } = createRequire(import.meta.url)('@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js') as { protocGenEs: Plugin }

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

/** The well-known types, which protoc-gen-es's code imports from the runtime rather than generating. */
const WELL_KNOWN = /^google\/protobuf\//u

/** Make a service's client. */
export function generateClient(spec: ClientSpec, place: ClientPlace): GeneratedClient {
  const files = ordered(spec.schema.file)
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
  const request = (parameter: string) => create(CodeGeneratorRequestSchema, {
    fileToGenerate: files.filter(file => !WELL_KNOWN.test(file.name ?? '')).map(file => file.name as string),
    protoFile: files,
    parameter,
  })
  const out = new Map<string, string>()
  for (const file of protocGenEs.run(request('target=js+dts,import_extension=js')).file) out.set(file.name ?? '', file.content ?? '')
  const index = clientPlugin(services.map(service => service.typeName), names, place)
  for (const file of index.run(request('target=js+dts,import_extension=js')).file) out.set(file.name ?? '', file.content ?? '')
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

/** The files, each after those it imports, as protoc's request has them. */
function ordered(files: readonly FileDescriptorProto[]): FileDescriptorProto[] {
  const byName = new Map(files.map(file => [file.name ?? '', file]))
  const out: FileDescriptorProto[] = []
  const seen = new Set<string>()
  const visit = (file: FileDescriptorProto): void => {
    const name = file.name ?? ''
    if (seen.has(name)) return
    seen.add(name)
    for (const dependency of file.dependency) {
      const imported = byName.get(dependency)
      if (imported === undefined) throw new SchemaError(`${name} imports ${dependency}, which the schema does not hold`)
      visit(imported)
    }
    out.push(file)
  }
  for (const file of files) visit(file)
  return out
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

/** What writes `index.js` and `index.d.ts`. */
function clientPlugin(services: readonly string[], names: ReadonlyMap<string, string>, place: ClientPlace): Plugin {
  const found = (schema: Schema): DescService[] => services.map(typeName => schema.allFiles.flatMap(file => file.services).find(service => service.typeName === typeName) as DescService)
  const reexports = (f: GeneratedFile, schema: Schema): void => {
    const files = new Set<DescFile>(found(schema).map(service => service.file))
    for (const file of files) f.print('export * from ', f.string(`./${file.name}_pb.js`), ';')
  }
  return createEcmaScriptPlugin({
    name: 'fleet-codegen',
    version: 'v0.0.1',
    generateTs: () => { throw new Error('fleet-codegen writes JavaScript and its declarations') },
    generateJs(schema) {
      const f = schema.generateFile('index.js')
      const createClient = f.import('createClient', '@connectrpc/connect')
      const createConnectTransport = f.import('createConnectTransport', '@connectrpc/connect-node')
      const connect = f.import('connect', 'node:net')
      f.print('const transport = ', createConnectTransport, '({')
      f.print('  baseUrl: ', f.string(`http://fleet${place.path}`), ',')
      f.print('  httpVersion: "2",')
      f.print('  nodeOptions: { createConnection: () => ', connect, '(process.env.', place.socketVariable, ' ?? ', f.string(place.socket), ') },')
      f.print('});')
      f.print()
      for (const service of found(schema)) {
        f.print(f.jsDoc(service))
        f.print(f.export('const', names.get(service.typeName) as string), ' = ', createClient, '(', f.importSchema(service), ', transport);')
        f.print()
      }
      reexports(f, schema)
    },
    generateDts(schema) {
      const f = schema.generateFile('index.d.ts')
      const callOptions = f.import('CallOptions', '@connectrpc/connect', true)
      const initShape = f.import('MessageInitShape', '@bufbuild/protobuf', true)
      for (const service of found(schema)) {
        const name = names.get(service.typeName) as string
        const type = `${name.replace(/^[a-z]/u, letter => letter.toUpperCase())}Client`
        f.print(f.jsDoc(service))
        f.print(f.export('interface', type), ' {')
        for (const method of service.methods) {
          const input = [initShape, '<typeof ', f.importSchema(method.input, true), '>']
          const output = f.importShape(method.output)
          f.print(f.jsDoc(method, '  '))
          const request = method.methodKind === 'client_streaming' || method.methodKind === 'bidi_streaming' ? ['AsyncIterable<', ...input, '>'] : input
          const response = method.methodKind === 'server_streaming' || method.methodKind === 'bidi_streaming' ? ['AsyncIterable<', output, '>'] : ['Promise<', output, '>']
          f.print('  ', method.localName, '(request: ', ...request, ', options?: ', callOptions, '): ', ...response, ';')
        }
        f.print('}')
        f.print()
        f.print(f.jsDoc(service))
        f.print(f.export('declare const', name), ': ', type, ';')
        f.print()
      }
      reexports(f, schema)
    },
  })
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
    const about = comment(service)
    if (about !== '') lines.push('', about)
    lines.push('')
    for (const method of service.methods) {
      const doc = comment(method).split('\n')[0] ?? ''
      lines.push(`- \`${name}.${method.localName}(request)\`, ${shape(method)}${doc === '' ? '' : `: ${doc}`}`)
    }
  }
  const unary = services.flatMap(service => service.methods.filter(method => method.methodKind === 'unary').map(method => ({ service, method })))
  if (unary.length > 0) {
    const { service, method } = unary[0] as { service: DescService; method: DescMethod }
    lines.push(
      '',
      'A shell calls a method that answers once with its request as JSON, its fields in lower camel case:',
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

function comment(desc: DescService | DescMethod): string {
  return (getComments(desc).leading ?? '').trim().split('\n').map(line => line.trim()).join('\n').replace(/([^\n])\n(?!\n)/gu, '$1 ')
}
