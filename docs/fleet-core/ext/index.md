# fleet-core/ext

Extensions of the fleet host. An extension implements one API a tau may
declare (tau's docs/spec/apis.md) in two halves:

- **a client**, the module the tau's programs import as `@api/<name>`, which
  runs in the box;
- **a server**, its methods, which run in dsh, and which the client calls
  through fleet.

Each extension is a package and a dsh plugin of its own, such as
`ext/fleet-ext-notes` (docs/fleet-ext-notes/index.md). fleet provides only
what connects the halves. A run of a tau links each API it declares to the
client of the extension that implements it (docs/fleet-core/tau/index.md).

## Provides

`fleet-exts` (`fleet-core/ext/plugin`), a dsh plugin that fleet-core's
`cordis.patch.yml` mounts. It provides `ctx.fleetExts`, which holds the
extensions provided:

```ts
import type {} from 'fleet-core/ext/plugin'   // for ctx.fleetExts

export const inject = ['fleetExts']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.fleetExts.provide({
    api: 'notes',                              // the API it implements, by its name in api/<name>/
    client: '/…/lib/client/',                  // index.js, with its declarations beside it
    methods: { addNote: (args, { sessionId, signal }) => … },
  }))
}
```

- `provide(ext)` provides an extension until the function it returns is
  called, as the plugin's effect does when the plugin unloads. A second
  extension of the same API is refused.
- `get(api)` gives the extension that implements an API, if one is
  provided.

## Design

- **The client is copied into each box** whose tau declares its API, when
  the run is created. So the client and the server always come from the
  same package, and adding an API means installing a dsh plugin, without
  rebuilding the image. The client must be self-contained: it imports only
  its own files, Node's modules, and fleet's client runtime,
  `fleet-image/ext/client`, which the box finds in its link tree. A client
  that needs a package bundles it.
- **The client is the implementation the API is checked against.** A run
  checks each API with tau's `checkImplementation` against the client's
  `index.js` and the declarations beside it, and is refused if the client
  does not fit.
- **A call** goes from the client to the box's helper over its call socket
  (docs/fleet-image/helper/index.md), and from the helper to the host as a
  `call`. The runs of taus serve it (`tau/runs.ts`): it must name an API
  the session's tau declares and a method its server has. A call that
  passes goes to that method with the session and a signal.
- **The session is the box's.** The host knows which session made a call
  from which box's helper sent it, and never from the call. So a client
  cannot act for another session.
- **A server checks its arguments.** The model controls everything in the
  box, so a method takes the arguments as JSON, unchecked. Its result must
  be JSON, or nothing for null; what it throws reaches the client as a
  failure with its message.
- **A caller that goes away** aborts the method's signal: the client's own
  signal, the program's exit, or the box's helper ending.
- **A client carries its own encodings.** Only JSON crosses, so a client
  turns other values, such as dates and bytes, into JSON and back, as its
  API declares them.
- **The model reaches the APIs** with `ts_modules` and `ts_execute`
  (docs/fleet-core/tools/index.md). A program run another way, such as with
  bash's `node`, finds them from a file below `/tau`.

## Not yet

- **The `tau` API** (`values`, `run`) has no extension.

## Built on

- `@sleepymug/tau`: `loadApis`, `checkImplementation`, `loadExposed`.
- The helper's call socket and `apis.link` (fleet-image).
- `@deepseek-ai/cordis`, for the plugin.
