# fleet-ext-notes

An extension of the fleet host (docs/fleet-core/ext/index.md), and the
example of one: the contract `@sleepymug/tau-api-notes`, a notebook of
short notes, each with tags to find them by later, which persist. Each
session has a notebook of its own, which its server keeps in the dsh home,
as `fleet/notes/<session>.json`, so its notes outlast dsh's process.

## Provides

A dsh bundle, whose `cordis.patch.yml` mounts `@sleepymug/fleet-ext-notes/plugin`,
its config naming the dsh home. It provides the extension of
`@sleepymug/tau-api-notes` to `ctx.fleetExts`, at the version of the
contract's package it depends on, and types its client by:

| Half | Module | |
|---|---|---|
| client | `src/client/index.ts`, built as `lib/client/` | What a tau's programs import as the API that holds a copy of the contract, such as `@api/notes`, in the box: `addNote(text, tags?)` and `byTag(tag)`, each calling its server. A note's `written` crosses as an ISO date, which the client turns into a `Date`. |
| server | `src/notes.ts` | The methods `addNote` and `byTag`, on the calling session's notebook, a file each, written whole. Each checks what the box sent. |

A tau uses it by holding a copy of the contract, made with tau's
`tau add notes @sleepymug/tau-api-notes`, as `examples/notebook` does.

## How it runs

```
pnpm exec dsh plugin --profile web add link:<checkout>/ext/fleet-ext-notes
```

lists it in the `web` profile's bundles, after fleet-core. Then a run of
`examples/notebook` saves a list as notes, and reports those with a tag:

```
$ fleet run <checkout>/examples/notebook list=list.txt tag=shop report=out/report.txt
```

A program below `/tau` in the session's box imports the API:

```ts
import { addNote, byTag } from '@api/notes'
await addNote('buy milk', ['shop'])
console.log((await byTag('shop')).map(note => note.text))   // [ 'buy milk' ]
```

## Built on

- `@sleepymug/fleet-box-runtime/ext/client`, in the box, which the client alone imports.
- `@sleepymug/fleet-core/ext/plugin`'s types, for `ctx.fleetExts`.
