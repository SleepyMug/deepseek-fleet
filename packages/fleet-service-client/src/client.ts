/**
 * A service's client in a box: each of a protobuf service's methods, taking
 * and giving plain objects (./plain.ts), calling the service through the
 * box's services socket, in Connect's protocol and protobuf's binary form.
 * @module @sleepymug/fleet-service-client/client
 */

import { connect } from 'node:net'
import { createFileRegistry, fromBinary, type DescMethod, type DescService, type Message, type Registry } from '@bufbuild/protobuf'
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError, createClient, type Transport } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { toMessage, toPlain } from './plain.ts'

/** Where a client finds its service. */
export interface ServicePlace {
  /** Where the service's calls go, `/services/<name>`. */
  path: string
  /** The socket every service is reached on, unless the variable `socketVariable` names another. */
  socket: string
  socketVariable: string
}

/** A call the service, or fleet, failed. */
export class CallError extends Error {
  constructor(
    message: string,
    /** Why, as Connect names it: `'not_found'`, `'invalid_argument'`, `'unavailable'`, and so on. */
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CallError'
  }
}

/** A schema, as a client embeds it: a `FileDescriptorSet` in base64. */
export function schema(base64: string): Registry {
  return createFileRegistry(fromBinary(FileDescriptorSetSchema, Buffer.from(base64, 'base64')))
}

/** The service `typeName` of `registry`, called at `place`: one function a method, by its name in lower camel case. */
export function serviceClient(registry: Registry, typeName: string, place: ServicePlace): Record<string, unknown> {
  const service = registry.getService(typeName)
  if (service === undefined) throw new Error(`the schema has no service ${typeName}`)
  const transport = createConnectTransport({
    baseUrl: `http://fleet${place.path}`,
    httpVersion: '2',
    useBinaryFormat: true,
    nodeOptions: { createConnection: () => connect(process.env[place.socketVariable] ?? place.socket) },
  })
  return Object.fromEntries(service.methods.map(method => [method.localName, methodOf(service, method, transport)]))
}

type Call = (request: unknown) => unknown

function methodOf(service: DescService, method: DescMethod, transport: Transport): (request?: unknown) => unknown {
  const call = (createClient(service, transport) as unknown as Record<string, Call>)[method.localName] as Call
  const name = `${service.name}.${method.name}`
  const input = (request: unknown): Message => toMessage(method.input, request ?? {}, `${name}'s request`)
  const output = (response: unknown): Record<string, unknown> => toPlain(method.output, response as Message)
  const inputs = async function* (requests: Iterable<unknown> | AsyncIterable<unknown>) {
    for await (const request of requests) yield input(request)
  }
  switch (method.methodKind) {
    case 'unary':
      return async request => output(await failing(async () => await call(input(request))))
    case 'client_streaming':
      return async requests => output(await failing(async () => await call(inputs(requests as Iterable<unknown>))))
    case 'server_streaming':
      return request => outputs(() => call(input(request)) as AsyncIterable<unknown>, output)
    case 'bidi_streaming':
      return requests => outputs(() => call(inputs(requests as Iterable<unknown>)) as AsyncIterable<unknown>, output)
  }
}

async function* outputs(start: () => AsyncIterable<unknown>, output: (response: unknown) => Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
  try {
    for await (const response of start()) yield output(response)
  } catch (error) {
    throw callError(error)
  }
}

async function failing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw callError(error)
  }
}

/** A Connect error as a `CallError`, its code as Connect names it; anything else, as a request that does not fit, as it is. */
function callError(error: unknown): unknown {
  if (!(error instanceof ConnectError)) return error
  const code = (Code[error.code] ?? 'Unknown').replace(/[A-Z]/gu, (letter, at: number) => `${at === 0 ? '' : '_'}${letter.toLowerCase()}`)
  return new CallError(error.rawMessage, code, { cause: error })
}
