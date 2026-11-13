# fleet-codegen

A service's client, made from its schema, `@sleepymug/fleet-codegen`: the
node package that the gateway puts in each box made with the service,
`@fleet/<name>`, whose methods call the service from the box, taking and
giving plain objects, and whose declarations, whole in one file, carry the
schema's comments, for whoever writes a program to read; and the service's
part of the box's README. Nothing here reads or writes a file.

## Provides

- `generateClient({ name, description, schema, services }, place)`: the
  client's files, by their path in its package, and its README section:
  - `index.d.ts` (`declarations.ts`), importing nothing: one client for each
    protobuf service the service serves, a constant named for it, `notes`
    for `notes.v1.Notes`, or with its package's name where two share one,
    its methods spelled out with their comments; then the type of each
    message and enum the methods reach, and no other, each with its
    comments, in the forms fleet-service-client converts
    (docs/fleet-service-client/index.md);
  - `index.js`: the clients, made with fleet-service-client from the schema,
    embedded without its comments, each calling `place.path` through
    `place.socket`, or `$FLEET_SERVICES_SOCKET`;
  - `package.json`, and `README.md`, the section.
  A schema that is not whole, or lacks a service it names, is a
  `SchemaError`.
- `RUNTIME`, what the clients import, `@sleepymug/fleet-service-client`, and
  `runtimeRoots()`, where it is installed beside this package, which the
  gateway stages into each box with what it depends on.
- `GENERATOR`, this package's version and fleet-service-client's, of which a
  client's digest is made, so that a client made by another is another.

What `index.d.ts` says, for a service with a oneof and an enum:

```ts
/** A notebook of short notes, each box its own. */
export declare const notes: {
  /** Keep a note, and give it back with its number. */
  add(request: AddRequest): Promise<Note>
  /** Every note with the tag, oldest first. */
  tagged(request: TaggedRequest): AsyncIterable<Note>
  /** Keep many notes at once. */
  addAll(requests: Iterable<AddRequest> | AsyncIterable<AddRequest>): Promise<Total>
  /** How many notes there are. */
  count(request?: CountRequest): Promise<Total>
}

/** One note. */
export type Note = {
  /** Its number in its notebook. */
  id: number
  written?: Date
  priority: Priority
  /** A file kept with it. */
  attachment: Uint8Array
  /** How long it is kept. In milliseconds. */
  kept?: number
} & (
  // Where it came from.
  | { /** Fetched from here. */ url: string; box?: never }
  | { /** Copied from this box. */ box: string; url?: never }
  | { url?: never; box?: never }
)

/**
 * How soon a note matters.
 * - `'PRIORITY_LOW'`: Whenever.
 * - `'PRIORITY_HIGH'`: Now.
 */
export type Priority = 'PRIORITY_UNSPECIFIED' | 'PRIORITY_LOW' | 'PRIORITY_HIGH'
```

## Design

- **The declarations are for reading.** An agent reads `index.d.ts` and
  nothing else: every call, what it takes and gives, and what each means,
  in TypeScript's plainest forms, with no protobuf in sight. A field whose
  presence a message keeps, a message's or an `optional` one, may be
  missing; every other is there; a oneof is a union of its fields, one
  given or none; a method whose request is empty may be called without it.
- **Names**: a nested message is `Outer_Inner`; a type whose name another
  shares, or TypeScript has, as `Date`, takes its package's, `NotesV1Note`.
- **What a box imports comes from the gateway**: the clients' runtime is
  staged from the gateway's own install, so a client and what it imports
  never drift apart, and no image holds them.

## Built on

- `@bufbuild/protobuf`, for the schema, and `@bufbuild/protoplugin`'s
  `getComments`.
- fleet-service-client, whose conversions the declarations describe.
- fleet-pack's `locate`, for the runtime.
