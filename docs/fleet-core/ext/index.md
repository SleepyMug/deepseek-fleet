# fleet-core/ext

Extensions of the fleet host. An extension implements one contract, an
API as it is published, at a version (tau's docs/spec/contracts.md), in two
halves:

- **a client**, the module the tau's programs import as `@api/<alias>`,
  where the tau holds a copy of the contract, which runs in the box;
- **a server**, its methods, which run in dsh, and which the client calls
  through fleet.

Each extension is a package and a dsh plugin of its own, such as
`ext/fleet-ext-notes` (docs/fleet-ext-notes/index.md). fleet provides only
what connects the halves. A run of a tau links each API it holds to the
client of the extension that implements its contract
(docs/fleet-core/tau/index.md).

## Provides

`fleet-exts` (`@sleepymug/fleet-core/ext/plugin`), a dsh plugin that fleet-core's
`cordis.patch.yml` mounts. It provides `ctx.fleetExts`, which holds the
extensions provided:

```ts
import type {} from '@sleepymug/fleet-core/services'   // for ctx.fleetExts

export const inject = ['fleetExts']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.fleetExts.provide({
    contract: '@sleepymug/tau-api-notes',      // the contract it implements, by its package's name
    version: '0.1.0',                          // and the version, as the contract's package has it
    client: '/…/lib/client/',                  // index.js
    methods: { addNote: (args, { sessionId, signal }) => … },
  }))
}
```

- `provide(ext)` provides an extension until the function it returns is
  called, as the plugin's effect does when the plugin unloads. A second
  extension of the same contract is refused.
- `get(contract)` gives the extension that implements a contract, if one
  is provided.

## Design

- **The client is copied into each box** whose tau holds its contract,
  when the run is created. So the client and the server always come from the
  same package, and adding an API means installing a dsh plugin, without
  rebuilding the image. The client must be self-contained: it imports only
  its own files, Node's modules, and fleet's client runtime,
  `@sleepymug/fleet-box-runtime/ext/client`, which the box finds in its link tree. A
  client that needs a package bundles it.
- **An extension says which contract it implements, and at which
  version.** A run links each API to the extension of its contract whose
  version serves the tau's copy, as tau's `serves` has it, and is refused
  if there is none; nothing checks the client against the copy's
  declarations. An extension depends on the contract's package at the
  version it implements, types its client by it, so that TypeScript checks
  the client as the package is built, and provides that version, read from
  the package, as `ext/fleet-ext-notes` does.
- **A call** goes from the client to the box's helper over its call socket
  (docs/fleet-box-runtime/helper/index.md), and from the helper to the host as
  a `call`. The runs of taus serve it (`tau/calls.ts`): it must name, by
  its contract, an API the session's tau holds, whatever alias the tau
  gives it, and a method its server has. A call that
  passes goes to that method with the session and a signal.
- **The session is the box's.** The host knows which session made a call
  from which box's helper sent it, and never from the call. So a client
  cannot act for another session.
- **A server checks its arguments.** The model controls everything in the
  box, so a method takes the arguments as JSON, unchecked. Its result must
  be JSON, or nothing for null; what it throws reaches the client as a
  failure with its message.
- **Bytes** cross beside the JSON, base64 between the helper and the host,
  for an archive, say: a call the client makes with `callStream` and a
  `body` gives the method `body`, an async iterable of the bytes, in its
  context; a method that answers with a `Streamed`,
  `{ [Symbol.for('fleet.streamed')]: true, value, body }`, or
  `streamed(value, body)` from `@sleepymug/fleet-core/box`, sends `value` as its
  result and `body` after it, which the client reads as `callStream`'s
  `body`. A body that fails on the way reaches the client cut short.
- **A caller that goes away** aborts the method's signal: the client's own
  signal, the program's exit, or the box's helper ending.
- **A client carries its own encodings.** JSON and bytes cross, so a client
  turns other values, such as dates, into JSON and back, as its API
  declares them.
- **The model reaches the APIs** with programs it runs with bash's `node`
  from the tau's directory, `cd /tau/self; node -`, which find them in
  `/tau/node_modules`; its prompt lists what its tau exposes
  (docs/fleet-core/tau/index.md).

## Not yet

- **Bytes have no back pressure** between the box and the host: each side
  holds what the other has not read yet, however much that is.

## Built on

- `@sleepymug/tau`: `loadTau`'s `apis` and `exposed`, `serves`, `parseVersion`.
- The helper's call socket and `apis.link` (fleet-box-runtime).
- `@deepseek-ai/cordis`, for the plugin.
