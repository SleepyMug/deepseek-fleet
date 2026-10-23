# fleet-ext-notes

An extension of the fleet host (docs/fleet-core/ext/index.md), and the
example of one: the contract `@sleepymug/tau-api-notes`, which it
publishes beside it, a notebook of
short notes, each with tags to find them by later. Each session has a
notebook of its own, which its server keeps in the dsh home, as
`fleet/notes/<session>.json`, so its notes outlast dsh's process, but a
later run, a session of its own, does not find them, as the contract
leaves to the implementation.

## Provides

A dsh bundle, whose `cordis.patch.yml` mounts `@sleepymug/fleet-ext-notes/plugin`,
its config naming the dsh home. It provides the extension of
`@sleepymug/tau-api-notes` to `ctx.fleetExts`, at the version of the
contract's package it depends on, and types its client by:

| Half | Module | |
|---|---|---|
| contract | `contract/`, the package `@sleepymug/tau-api-notes` | Its `package.json` and its declarations, `index.d.ts`, as tau's docs/spec/contracts.md has a contract: a workspace package of its own, since a contract's name and version are its identity, published beside the extension, which depends on it. |
| client | `src/client/index.ts`, built as `lib/client/` | What a tau's programs import as the API, by the contract's name, `@sleepymug/tau-api-notes`, in the box: `addNote(text, tags?)` and `byTag(tag)`, each calling its server. A note's `written` crosses as an ISO date, which the client turns into a `Date`. |
| server | `src/notes.ts` | The methods `addNote` and `byTag`, on the calling session's notebook, a file each, written whole. Each checks what the box sent. |

A tau uses it by naming the contract in its `apis`, `"@sleepymug/tau-api-notes":
"^0.1.0"`, as `examples/notebook` does; its author pulls the contract into
the tau's `.tau/` with `tau api add @sleepymug/tau-api-notes --from-provider`
(tau's docs/spec/authoring.md).

## How it runs

```
pnpm exec dsh plugin --profile web add link:<checkout>/ext/fleet-ext-notes
```

lists it in the `web` profile's bundles, after fleet-core. Then a run of
`examples/notebook` saves a list as notes, and reports those with a tag:

```
$ tau run --adaptor fleet <checkout>/examples/notebook --call-json '{"files": {"list": "list.txt", "report": "out/report.txt"}, "args": {"tag": "shop"}}'
```

A program below `/tau` in the session's box imports the API:

```ts
import { addNote, byTag } from '@sleepymug/tau-api-notes'
await addNote('buy milk', ['shop'])
console.log((await byTag('shop')).map(note => note.text))   // [ 'buy milk' ]
```

## Built on

- `@sleepymug/fleet-box-runtime/ext/client`, in the box, which the client alone imports.
- `@sleepymug/fleet-core/ext/define`, which provides it, and
  `@sleepymug/fleet-core/paths`, for the dsh home's `fleet/notes/`.
