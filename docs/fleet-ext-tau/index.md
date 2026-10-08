# fleet-ext-tau

An extension of the fleet host (docs/fleet-core/ext/index.md): the
contract `@sleepymug/tau-api`, the tau API of tau's docs/spec/tau-api.md,
with which a tau's programs read their
run's files and args, and run other taus, each a run of its own, in a box of its
own, started by the session that runs the program.

## Provides

A dsh bundle, whose `cordis.patch.yml` mounts `@sleepymug/fleet-ext-tau/plugin`. It
provides the extension of `@sleepymug/tau-api` to `ctx.fleetExts`, at the
version of the contract's package it depends on, on the tau service,
`ctx.fleetTau` (docs/fleet-core/tau/index.md):

| Half | Module | |
|---|---|---|
| client | `src/client/index.ts`, built as `lib/client/` | What a tau's programs import as the API that holds a copy of the contract, by convention `@api/tau`, in the box: `files()` and `args()`, which read the places of the run's files, extra files included, and its args, expanded, as the box's runtime kept them when it set the box up, and `run(agent, call, signal?, options?)`, which runs a tau with tau's `runTau` on the fleet host: it packs the call from the box's files, starts it, waits for it, and puts what it gave back at the box's paths; `options.history`, fleet's own, is where it writes the run's session's history; and `TAU_SKIP`, `TAU_RUN` and `TAU_FALLBACK`, the exit codes of a tau's init. |
| server | `src/tau.ts` | The methods `start`, with the call after its arguments `{ title, targets }`; `finish(id, { history? })`, which answers `{ result, targets, history? }` with the result after it; and `cancel`; each on the tau service as the calling session, which reaches only the runs it started. Each checks what the box sent. |

A tau uses it by holding a copy of the contract, made with tau's
`tau add tau @sleepymug/tau-api`, as `examples/relay` does.

## Design

- **A run from a box is a run like any other.** The service takes its call,
  checks it, and sets up a box for it, as for `fleet`'s; the run is in the
  calling session's project, and the calling session alone reaches it,
  besides `fleet`. The service never reads the caller's box: the client
  packs the call there, and puts the result there, where the targets say.
- **The bytes** of the call and the result cross the helper beside the
  JSON (`callStream`, docs/fleet-core/ext/index.md).
- **The client imports** `@sleepymug/fleet-box-runtime/ext/client`,
  `@sleepymug/fleet-box-runtime/ext/tau`, tau's caller's side, and
  `@sleepymug/fleet-box-runtime/tau/layout`, for where the files and args are kept.
- **A run's history**, beyond tau's spec, is fleet's: `run`'s fourth
  argument, `{ history }`, a path in the box, `process.cwd()`'s if
  relative, has `finish` ask for the run's session's history
  (docs/fleet-core/tau/index.md), and writes it there, dsh's events, one
  JSON object per line, its folder made if missing, before the result is
  put at its paths, whether the run succeeded or not. The contract does not
  declare it, so a program passes it as an argument its types do not
  name.
- **A run's runs go with it.** A run that ends deletes the runs it started
  and did not finish; `run` finishes each run it starts.

## How it runs

```
pnpm exec dsh plugin --profile web add link:<checkout>/ext/fleet-ext-tau
```

lists it in the `web` profile's bundles, after fleet-core. Then a run of
`examples/relay` runs the tau it holds, `taus/shout`, in a box of its own,
giving it its own `out` file, which the shout fills, and the relay gives
back:

```
$ fleet run <checkout>/examples/relay word=hello report=out/report.txt
fleet: started session-b2a1…
It said: {"value":{"result":{"ok":true,"text":"Shouted."},…}}
$ cat out/report.txt
HELLO
$ fleet list
session-b2a1…  finished  ok      relay
session-d430…  finished  ok      shout
```

A program below `/tau` in the session's box imports the API:

```ts
import { files, run } from '@api/tau'
const result = await run('/tau/self/taus/shout', { files: { out: files().report }, args: { text: 'hello' } })
```

## Built on

- `@sleepymug/fleet-box-runtime/ext/client`, `@sleepymug/fleet-box-runtime/ext/tau` and
  `@sleepymug/fleet-box-runtime/tau/layout`, in the box, which the client alone imports.
- `@sleepymug/fleet-core/ext/plugin`'s and `@sleepymug/fleet-core/tau/plugin`'s types, for
  `ctx.fleetExts` and `ctx.fleetTau`.
