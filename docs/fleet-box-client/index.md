# fleet-box-client

What a service's client in a box runs on, `@sleepymug/fleet-box-client`:
the gateway stages it into each box's `/fleet/node_modules`, and each
client fleet-codegen makes imports it (docs/fleet-codegen/index.md). It
turns the plain objects a program gives into the service's protobuf
messages, by the schema the client embeds, calls the service in Connect's
protocol and protobuf's binary form, and turns what comes back into plain
objects again.

## Provides

- `schema(base64)`: a registry of the schema a client embeds.
- `serviceClient(registry, typeName, { path, socket, socketVariable })`:
  one function a method, by its name in lower camel case. A unary method
  takes a plain request and answers a `Promise` of a plain response; one
  that streams its responses answers an `AsyncIterable`, which a program
  leaving the loop cancels; one that streams its requests takes an
  iterable, or an async one. Each calls through one HTTP/2 connection to
  the socket, `$<socketVariable>` or `socket`, which keeps no program alive
  once its calls are done.
- `CallError`: a call the service, or fleet, failed, its `code` as Connect
  names it, `'not_found'`, `'invalid_argument'`, `'unavailable'`, and its
  message the service's own.
- `toMessage(desc, plain)` and `toPlain(desc, message)`: the conversions;
  `wellKnown(desc)` and `isLong(scalar)`, which fleet-codegen declares by.

## Plain objects

A plain object is a message's fields by their JSON names:

| Protobuf | Plain |
|---|---|
| `string`, `bool`, `double`, `float`, 32-bit integers | `string`, `boolean`, `number` |
| 64-bit integers | `number`, exact up to 2^53; a `bigint` or a string is taken too |
| `bytes` | `Uint8Array`, such as a Buffer |
| an enum | its value's name, `'PRIORITY_HIGH'` |
| `repeated` | an array |
| `map<K, V>` | an object, its keys strings |
| a oneof | its fields as any others, one given at most |
| `google.protobuf.Timestamp` | a `Date`; an ISO string is taken too |
| `google.protobuf.Duration` | a number of milliseconds |
| `Struct`, `Value`, `ListValue` | the JSON they hold |
| `StringValue` and the other wrappers | the value they wrap |

A field left out of a request is its zero value; a response has every field
but those whose presence it keeps and lacks, a message's or an `optional`
one unset.

## Design

- **What does not fit is refused here**, before any call, saying where and
  why: a field the message has not, with those it has, which catches a
  misspelling; two of one oneof; a string as bytes, which would otherwise
  be sent as something else; an enum name it has not, with those it has.
- **It never throws Connect's errors**, which a program would need Connect
  to read: a `CallError` carries the code as a string.

## Built on

- `@bufbuild/protobuf`, for the messages and their binary form.
- `@connectrpc/connect` and `@connectrpc/connect-node`, for the calls.
