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
| client | `src/client/index.ts`, built as `lib/client/` | What a tau's programs import as the API, by the contract's name, `@sleepymug/tau-api`, in the box: `files()` and `args()`, which read the places of the run's files, extra files included, and its args, expanded, as the box's runtime kept them when it set the box up, and `run(tau, call, signal?, options?)`, which runs a tau with tau's client and its fleet adaptor on the fleet host: it packs the call from the box's files, submits it, waits for it, puts what it gave back at the box's paths, and releases it; `options.trace`, fleet's own, is where it writes the run's trace; and `TAU_SKIP`, `TAU_RUN` and `TAU_FALLBACK`, the exit codes of a tau's init. |
| server | `src/tau.ts` | The method `exchange(request)`, with the bytes after it, if any: the relay of tau's fleet adaptor, which passes each request, a run's or the service's own, to the tau service as the calling session's, `ctx.fleetTau.handlerFor`, which reaches only the runs it started, and answers with the service's answer, with the bytes after it, if any. The service checks each request. |

A tau uses it by naming the contract, tau's `contracts/tau-api`, in its
`apis`, `"@sleepymug/tau-api": "^0.1.0"`, as `examples/relay` does.

## Design

- **A run from a box is a run like any other.** tau's client in the box
  checks the call and the box's paths, and its fleet adaptor submits it
  through the relay; the service admits it, and sets up a box for it, as
  for the host's `tau`; the run is in the calling session's project, and
  the calling session alone reaches it, besides the host. The service
  never learns the caller's paths: the client packs the call in the box,
  and its adaptor checks the result and puts it there.
- **The relay** is `relayTransport` (`@sleepymug/fleet-box-runtime/ext/tau`),
  a transport of tau's fleet adaptor through this extension's `exchange`:
  the bytes of the call and the result cross the helper beside the JSON
  (`callStream`, docs/fleet-core/ext/index.md), and the host, not the box,
  says whose session the request is.
- **The client imports** `@sleepymug/fleet-box-runtime/ext/tau`, tau's
  client, its fleet adaptor and the relay, and
  `@sleepymug/fleet-box-runtime/tau/layout`, for where the files and args are kept.
- **A run's trace**, beyond the tau API's contract, is fleet's: `run`'s
  fourth argument, `{ trace }`, a path in the box, `process.cwd()`'s if
  relative, has `run` finish the run, ask for the run's trace, its
  session's events (docs/fleet-core/tau/index.md), and write it there, as
  `tau trace` prints it, its folder made if missing, whether the run
  succeeded or not, before it releases the run. The contract does not
  declare it, so a program passes it as an argument its types do not
  name.
- **A run's runs go with it.** A run that ends releases the runs it
  started whose result it did not take; `run` finishes and releases each
  run it starts, and aborting its signal releases it.

## How it runs

```
pnpm exec dsh plugin --profile web add link:<checkout>/ext/fleet-ext-tau
```

lists it in the `web` profile's bundles, after fleet-core. Then a run of
`examples/relay` runs the tau it holds, `taus/shout`, in a box of its own,
giving it its own `out` file, which the shout fills, and the relay gives
back:

```
$ tau start --adaptor fleet <checkout>/examples/relay --call-json '{"files": {"report": "out/report.txt"}, "args": {"word": "hello"}}'
fleet:session-b2a1…
$ tau finish fleet:session-b2a1…
It said: Shouted.
$ cat out/report.txt
HELLO
$ fleet list
session-b2a1…  finished  ok      relay
```

A program below `/tau` in the session's box imports the API:

```ts
import { files, run } from '@sleepymug/tau-api'
const result = await run('/tau/self/taus/shout', { files: { out: files().report }, args: { text: 'hello' } })
```

## Built on

- `@sleepymug/fleet-box-runtime/ext/client`, `@sleepymug/fleet-box-runtime/ext/tau` and
  `@sleepymug/fleet-box-runtime/tau/layout`, in the box, which the client alone imports.
- `@sleepymug/fleet-core/ext/define`, which provides it, and
  `@sleepymug/fleet-core/services`, for `ctx.fleetTau`.
