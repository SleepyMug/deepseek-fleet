/**
 * A client's declarations, `index.d.ts`: whole in one file, importing
 * nothing, so that whoever writes a program reads what each method takes
 * and gives there, and nowhere else. Each client is a constant of its
 * methods; each message the methods reach is a plain object's type, each
 * enum a union of its values' names, as fleet-box-client converts them
 * (its plain.ts); and each carries its comment from the schema.
 * @module @sleepymug/fleet-codegen/declarations
 */

import type { DescEnum, DescField, DescMessage, DescMethod, DescOneof, DescService } from '@bufbuild/protobuf'
import { ScalarType } from '@bufbuild/protobuf'
import { getComments } from '@bufbuild/protoplugin'
import { wellKnown } from '@sleepymug/fleet-box-client'

/** What the declarations say of the client as a whole. */
export interface Heading {
  /** The client's package, `@fleet/<name>`. */
  package: string
  /** The service's name. */
  name: string
  /** What the service is. */
  description: string
}

/** The declarations of the clients of `services`, each by its name in `names`. */
export function declarations(heading: Heading, services: readonly DescService[], names: ReadonlyMap<string, string>): string {
  const types = reachable(services)
  const typeNames = namesOf(types)
  const out: string[] = [
    ...doc([
      `${heading.package}: the ${heading.name} service, called from this box.`,
      ...(heading.description === '' ? [] : ['', heading.description]),
      '',
      'Its methods take and give plain objects. A field left out of a request',
      "is its zero value: '', 0, false, [] or {}. A call that fails throws an",
      "Error whose `code` says why: 'not_found', 'invalid_argument',",
      "'unavailable', and so on.",
    ].join('\n'), ''),
    '',
  ]
  for (const service of services) out.push(...client(service, names.get(service.typeName) as string, typeNames), '')
  for (const type of types) out.push(...(type.kind === 'message' ? message(type, typeNames) : enumeration(type, typeNames)), '')
  return `${out.join('\n').trimEnd()}\n`
}

function client(service: DescService, name: string, typeNames: ReadonlyMap<string, string>): string[] {
  const lines = [...doc(comment(service), ''), `export declare const ${name}: {`]
  for (const method of service.methods) lines.push(...doc(comment(method), '  '), `  ${signature(method, typeNames)}`)
  lines.push('}')
  return lines
}

function signature(method: DescMethod, typeNames: ReadonlyMap<string, string>): string {
  const input = typeNames.get(method.input.typeName) as string
  const output = typeNames.get(method.output.typeName) as string
  const streamsIn = method.methodKind === 'client_streaming' || method.methodKind === 'bidi_streaming'
  const streamsOut = method.methodKind === 'server_streaming' || method.methodKind === 'bidi_streaming'
  // A request with nothing in it need not be given.
  const parameter = streamsIn ? `requests: Iterable<${input}> | AsyncIterable<${input}>` : `request${method.input.fields.length === 0 ? '?' : ''}: ${input}`
  return `${method.localName}(${parameter}): ${streamsOut ? `AsyncIterable<${output}>` : `Promise<${output}>`}`
}

function message(desc: DescMessage, typeNames: ReadonlyMap<string, string>): string[] {
  const name = typeNames.get(desc.typeName) as string
  const fields = desc.fields.filter(field => field.oneof === undefined).flatMap(field => [
    ...doc(fieldComment(field), '  '),
    `  ${field.jsonName}${hasPresence(field) ? '?' : ''}: ${fieldType(field, typeNames)}`,
  ])
  const lines = doc(comment(desc), '')
  if (desc.oneofs.length === 0) return fields.length === 0 ? [...lines, `export interface ${name} {}`] : [...lines, `export interface ${name} {`, ...fields, '}']
  lines.push(`export type ${name} = ${fields.length > 0 ? `{\n${fields.join('\n')}\n} & ` : ''}(`)
  desc.oneofs.forEach((oneof, i) => {
    if (i > 0) lines.push(') & (')
    lines.push(...oneofAlternatives(oneof, typeNames))
  })
  lines.push(')')
  return lines
}

/** A oneof: one alternative for each of its fields, that one given and the others not, and one with none given. */
function oneofAlternatives(oneof: DescOneof, typeNames: ReadonlyMap<string, string>): string[] {
  const lines = comment(oneof) === '' ? [] : comment(oneof).split('\n').map(line => `  // ${line}`)
  for (const field of oneof.fields) {
    const others = oneof.fields.filter(other => other !== field).map(other => `${other.jsonName}?: never`)
    const about = fieldComment(field)
    const given = `${field.jsonName}: ${fieldType(field, typeNames)}`
    if (about.includes('\n')) lines.push('  | {', ...doc(about, '      '), `      ${given}`, ...others.map(other => `      ${other}`), '    }')
    else lines.push(`  | { ${about === '' ? '' : `/** ${about} */ `}${[given, ...others].join('; ')} }`)
  }
  lines.push(`  | { ${oneof.fields.map(field => `${field.jsonName}?: never`).join('; ')} }`)
  return lines
}

function enumeration(desc: DescEnum, typeNames: ReadonlyMap<string, string>): string[] {
  const values = desc.values.filter(value => comment(value) !== '').map(value => `- \`'${value.name}'\`: ${comment(value).replace(/\n/gu, ' ')}`)
  const about = [comment(desc), values.join('\n')].filter(part => part !== '').join('\n')
  return [...doc(about, ''), `export type ${typeNames.get(desc.typeName) as string} = ${desc.values.map(value => `'${value.name}'`).join(' | ')}`]
}

/** A field's type, as its plain object has it. */
function fieldType(field: DescField, typeNames: ReadonlyMap<string, string>): string {
  const item = (kind: 'scalar' | 'enum' | 'message'): string => {
    switch (kind) {
      case 'scalar': return scalarType(field.scalar as ScalarType)
      case 'enum': return typeNames.get((field.enum as DescEnum).typeName) as string
      case 'message': return messageType(field.message as DescMessage, typeNames)
    }
  }
  switch (field.fieldKind) {
    case 'list': return `${item(field.listKind)}[]`
    case 'map': return `Record<string, ${item(field.mapKind)}>`
    default: return item(field.fieldKind)
  }
}

function scalarType(scalar: ScalarType): string {
  switch (scalar) {
    case ScalarType.STRING: return 'string'
    case ScalarType.BOOL: return 'boolean'
    case ScalarType.BYTES: return 'Uint8Array'
    default: return 'number'
  }
}

function messageType(desc: DescMessage, typeNames: ReadonlyMap<string, string>): string {
  switch (wellKnown(desc)) {
    case 'date': return 'Date'
    case 'duration': return 'number'
    case 'json': return desc.typeName === 'google.protobuf.Struct' ? '{ [key: string]: unknown }' : desc.typeName === 'google.protobuf.ListValue' ? 'unknown[]' : 'unknown'
    case 'wrapper': return scalarType((desc.fields[0] as DescField).scalar as ScalarType)
    default: return typeNames.get(desc.typeName) as string
  }
}

/** Whether a field may be missing from a plain object: one whose presence a message keeps, as a message's or an `optional` one, unless a oneof's. */
function hasPresence(field: DescField): boolean {
  return field.fieldKind !== 'list' && field.fieldKind !== 'map' && field.presence === EXPLICIT
}

/** `FeatureSet.FieldPresence.EXPLICIT`. */
const EXPLICIT = 1

function fieldComment(field: DescField): string {
  const about = comment(field)
  const unit = field.fieldKind === 'message' && wellKnown(field.message) === 'duration' ? 'In milliseconds.' : ''
  return [about, unit].filter(part => part !== '').join(' ')
}

/** The messages and enums the methods take and give, and those their fields have, in the order first reached; the well-known ones with plain forms of their own aside. */
function reachable(services: readonly DescService[]): (DescMessage | DescEnum)[] {
  const out: (DescMessage | DescEnum)[] = []
  const seen = new Set<string>()
  const visit = (desc: DescMessage | DescEnum): void => {
    if (seen.has(desc.typeName) || (desc.kind === 'message' && wellKnown(desc) !== undefined)) return
    seen.add(desc.typeName)
    out.push(desc)
    if (desc.kind === 'enum') return
    for (const field of desc.fields) {
      if (field.message !== undefined) visit(field.message)
      if (field.enum !== undefined) visit(field.enum)
    }
  }
  for (const service of services) for (const method of service.methods) {
    visit(method.input)
    visit(method.output)
  }
  return out
}

/** Names TypeScript, or the declarations themselves, already give. */
const TAKEN = new Set(['Date', 'Uint8Array', 'Record', 'Promise', 'Iterable', 'AsyncIterable', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Error', 'Map', 'Set', 'Function', 'Symbol',
  'string', 'number', 'boolean', 'object', 'any', 'unknown', 'never', 'symbol', 'bigint', 'undefined', 'null', 'void'])

/** Each type's name: its own, a nested one's with its parents', `Outer_Inner`; or, where two share it or TypeScript has it, with its package's, `NotesV1Note`. */
function namesOf(types: readonly (DescMessage | DescEnum)[]): Map<string, string> {
  const own = (desc: DescMessage | DescEnum): string => {
    const parts: string[] = []
    for (let at: DescMessage | DescEnum | undefined = desc; at !== undefined; at = at.parent) parts.unshift(at.name)
    return parts.join('_')
  }
  const counts = new Map<string, number>()
  for (const type of types) counts.set(own(type), (counts.get(own(type)) ?? 0) + 1)
  return new Map(types.map((type) => {
    const name = own(type)
    if ((counts.get(name) ?? 0) === 1 && !TAKEN.has(name)) return [type.typeName, name]
    const prefix = type.file.proto.package.split('.').map(part => part.replace(/^[a-z]/u, letter => letter.toUpperCase())).join('')
    return [type.typeName, `${prefix}${name}`]
  }))
}

/** A descriptor's leading comment, as the schema has it, its lines trimmed. */
export function comment(desc: Parameters<typeof getComments>[0]): string {
  return (getComments(desc).leading ?? '').split('\n').map(line => line.trim()).join('\n').trim()
}

/** `text` as a JSDoc comment, indented by `indent`; nothing if it is empty. */
function doc(text: string, indent: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\*\//gu, '*\\/').split('\n')
  if (lines.length === 1) return [`${indent}/** ${lines[0] as string} */`]
  return [`${indent}/**`, ...lines.map(line => `${indent} * ${line}`.trimEnd()), `${indent} */`]
}
