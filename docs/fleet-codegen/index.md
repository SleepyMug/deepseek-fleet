# fleet-codegen

A service's client, made from its schema, `@sleepymug/fleet-codegen`: the
node package that the gateway puts in each box made with the service,
`@fleet/<name>`, whose methods call the service from the box, and whose
declarations carry the schema's comments, for whoever writes a program to
read; and the service's part of the box's README. Nothing here reads or
writes a file.

## Provides

- `generateClient({ name, description, schema, services }, place)`: the
  client's files, by their path in its package, and its README section:
  - each file of the schema, as protoc-gen-es writes it, JavaScript with its
    declarations, the comments as JSDoc, but the well-known types, which
    `@bufbuild/protobuf` has;
  - `index.js` and `index.d.ts`: one client for each protobuf service the
    service serves, named for it, `notes` for `notes.v1.Notes`, or with its
    package's name where two share one, its methods declared one by one,
    each with its comment: a unary method answers a `Promise` of its
    message, a streaming one an `AsyncIterable`, and a request is its
    message's init shape, a plain object; every client calls through one
    connection to `place.socket`, or `$FLEET_SERVICES_SOCKET`, at
    `place.path`;
  - `package.json`, and `README.md`, the section.
  A schema that is not whole, or lacks a service it names, is a
  `SchemaError`.
- `RUNTIME`, what the clients import, `@bufbuild/protobuf`,
  `@connectrpc/connect` and `@connectrpc/connect-node`, at the versions this
  package pins with protoc-gen-es, and `runtimeRoots()`, where they are
  installed beside it, which the gateway stages into each box.
- `GENERATOR`, this package's version and protoc-gen-es's, of which a
  client's digest is made, so that a client made by another is another.

## Design

- **protoc-gen-es runs here**, as a function of the request protoc would
  give it, built from the schema, so the gateway needs neither protoc nor
  buf; a server's schema is buf's, with its comments, since what generated
  code embeds has none.
- **The declarations are for reading**: each method spelled out with its
  comment, rather than a type that maps the service, so that an agent that
  reads `index.d.ts` finds every call and what it means.

## Built on

- `@bufbuild/protoplugin` and `@bufbuild/protoc-gen-es`.
- fleet-pack's `locate`, for the runtime's packages.
