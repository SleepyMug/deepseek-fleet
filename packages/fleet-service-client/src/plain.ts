/**
 * Plain objects, as a client's declarations have them, to and from a
 * service's protobuf messages, by the service's schema. A plain object is
 * a message's fields by their JSON names, nothing more:
 * - `bytes` is a `Uint8Array`, such as a Buffer;
 * - a 64-bit integer is a `number`, exact up to 2^53;
 * - an enum is its value's name, `'HIGH'`;
 * - a oneof is its fields as any others, one of them at most given;
 * - `google.protobuf.Timestamp` is a `Date`, `Duration` a number of
 *   milliseconds, `Struct`, `Value` and `ListValue` the JSON they hold,
 *   and a wrapper, `StringValue` and the like, the value it wraps;
 * - a map is an object, its keys strings.
 * A field left out of a plain object is the field's zero value; one a
 * message lacks, a field with presence that is unset, is left out of its
 * plain object.
 * @module @sleepymug/fleet-service-client/plain
 */

import { create, fromJson, isMessage, ScalarType, toJson, type DescEnum, type DescField, type DescMessage, type JsonValue, type Message } from '@bufbuild/protobuf'
import { durationFromMs, durationMs, isWrapperDesc, timestampDate, timestampFromDate, type Timestamp, type Duration } from '@bufbuild/protobuf/wkt'

/** How a well-known message is plain: as a `Date`, a number of milliseconds, the JSON it holds, or the value it wraps. */
export type WellKnown = 'date' | 'duration' | 'json' | 'wrapper'

/** How a message is plain, if it is a well-known one with a plain form of its own. */
export function wellKnown(desc: DescMessage): WellKnown | undefined {
  switch (desc.typeName) {
    case 'google.protobuf.Timestamp': return 'date'
    case 'google.protobuf.Duration': return 'duration'
    case 'google.protobuf.Struct':
    case 'google.protobuf.Value':
    case 'google.protobuf.ListValue': return 'json'
    default: return isWrapperDesc(desc) ? 'wrapper' : undefined
  }
}

/** Whether a scalar is a 64-bit integer, a `bigint` in protobuf-es and a `number` when plain. */
export function isLong(scalar: ScalarType): boolean {
  return scalar === ScalarType.INT64 || scalar === ScalarType.UINT64 || scalar === ScalarType.SINT64 || scalar === ScalarType.FIXED64 || scalar === ScalarType.SFIXED64
}

/** A plain object as the message `desc`; `at` names where it is, for what is wrong with it. */
export function toMessage(desc: DescMessage, plain: unknown, at: string = desc.name): Message {
  if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) throw new TypeError(`${at}: is an object, a ${desc.name}`)
  const given = plain as Record<string, unknown>
  const fields = new Map(desc.fields.map(field => [field.jsonName, field]))
  for (const key of Object.keys(given)) {
    if (!fields.has(key)) throw new TypeError(`${at}: ${desc.name} has no field ${key}; its fields are ${[...fields.keys()].join(', ') || 'none'}`)
  }
  const init: Record<string, unknown> = {}
  for (const field of desc.fields) {
    const value = given[field.jsonName]
    if (value === undefined || value === null) continue
    const converted = fieldIn(field, value, `${at}.${field.jsonName}`)
    if (field.oneof === undefined) {
      init[field.localName] = converted
      continue
    }
    const chosen = init[field.oneof.localName] as { case: string } | undefined
    if (chosen !== undefined) {
      const other = field.oneof.fields.find(each => each.localName === chosen.case)?.jsonName
      throw new TypeError(`${at}: ${other} and ${field.jsonName} are one of ${field.oneof.name}; give one of them at most`)
    }
    init[field.oneof.localName] = { case: field.localName, value: converted }
  }
  return create(desc, init)
}

/** The message `message`, of `desc`, as a plain object. */
export function toPlain(desc: DescMessage, message: Message): Record<string, unknown> {
  const fields = message as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const member of desc.members) {
    if (member.kind === 'oneof') {
      const chosen = fields[member.localName] as { case: string | undefined; value?: unknown }
      const field = member.fields.find(each => each.localName === chosen.case)
      if (field !== undefined) define(out, field.jsonName, fieldOut(field, chosen.value))
      continue
    }
    const value = fields[member.localName]
    if (value !== undefined) define(out, member.jsonName, fieldOut(member, value))
  }
  return out
}

function fieldIn(field: DescField, value: unknown, at: string): unknown {
  switch (field.fieldKind) {
    case 'list':
      if (!Array.isArray(value)) throw new TypeError(`${at}: is a list`)
      return value.map((item, i) => valueIn(field.listKind, field, item, `${at}[${i}]`, false))
    case 'map':
      if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${at}: is an object`)
      return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, valueIn(field.mapKind, field, item, `${at}.${key}`, false)]))
    default:
      return valueIn(field.fieldKind, field, value, at, true)
  }
}

function fieldOut(field: DescField, value: unknown): unknown {
  switch (field.fieldKind) {
    case 'list':
      return (value as unknown[]).map(item => valueOut(field.listKind, field, item))
    case 'map':
      return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, valueOut(field.mapKind, field, item)]))
    default:
      return valueOut(field.fieldKind, field, value)
  }
}

type Kind = 'scalar' | 'enum' | 'message'

/** A field's value, or a list's or a map's item: `singular`, a field's own, as protobuf-es unboxes wrappers and `Struct` in. */
function valueIn(kind: Kind, field: DescField, value: unknown, at: string, singular: boolean): unknown {
  switch (kind) {
    case 'scalar': return scalarIn(field.scalar as ScalarType, longAsString(field), value, at)
    case 'enum': return enumIn(field.enum as DescEnum, value, at)
    case 'message': return messageIn(field.message as DescMessage, value, at, singular)
  }
}

function valueOut(kind: Kind, field: DescField, value: unknown): unknown {
  switch (kind) {
    case 'scalar': return scalarOut(field.scalar as ScalarType, value)
    case 'enum': return (field.enum as DescEnum).value[value as number]?.name ?? value
    case 'message': return messageOut(field.message as DescMessage, value)
  }
}

function scalarIn(scalar: ScalarType, longAsString: boolean, value: unknown, at: string): unknown {
  if (isLong(scalar)) {
    if (typeof value === 'number' && !Number.isInteger(value)) throw new TypeError(`${at}: is an integer, not ${value}`)
    if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') throw new TypeError(`${at}: is an integer`)
    return longAsString ? String(value) : BigInt(value)
  }
  if (scalar === ScalarType.BYTES && !(value instanceof Uint8Array)) throw new TypeError(`${at}: is bytes, a Uint8Array such as a Buffer`)
  return value
}

function scalarOut(scalar: ScalarType, value: unknown): unknown {
  return isLong(scalar) ? Number(value) : value
}

function enumIn(desc: DescEnum, value: unknown, at: string): number {
  if (typeof value === 'number') return value
  const found = desc.values.find(each => each.name === value)
  if (found === undefined) throw new TypeError(`${at}: is one of ${desc.values.map(each => `'${each.name}'`).join(', ')}`)
  return found.number
}

function messageIn(desc: DescMessage, value: unknown, at: string, singular: boolean): unknown {
  switch (wellKnown(desc)) {
    case 'date': {
      const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined
      if (date === undefined || Number.isNaN(date.getTime())) throw new TypeError(`${at}: is a Date`)
      return timestampFromDate(date)
    }
    case 'duration':
      if (typeof value !== 'number') throw new TypeError(`${at}: is a number of milliseconds`)
      return durationFromMs(value)
    case 'json':
      return fromJson(desc, value as JsonValue)
    case 'wrapper': {
      const inner = desc.fields[0] as DescField
      const unwrapped = scalarIn(inner.scalar as ScalarType, longAsString(inner), value, at)
      return singular ? unwrapped : create(desc, { value: unwrapped })
    }
    default:
      return toMessage(desc, value, at)
  }
}

function messageOut(desc: DescMessage, value: unknown): unknown {
  switch (wellKnown(desc)) {
    case 'date': return timestampDate(value as Timestamp)
    case 'duration': return durationMs(value as Duration)
    case 'json': return isMessage(value) ? toJson(desc, value) : value
    case 'wrapper': {
      const inner = desc.fields[0] as DescField
      return scalarOut(inner.scalar as ScalarType, isMessage(value) ? (value as unknown as { value: unknown }).value : value)
    }
    default: return toPlain(desc, value as Message)
  }
}

/** Whether a 64-bit field is a string in protobuf-es, as `jstype = JS_STRING` has it. */
function longAsString(field: DescField): boolean {
  return (field as { longAsString?: boolean }).longAsString === true
}

/** Set a key as its own, even one such as `__proto__`. */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}
