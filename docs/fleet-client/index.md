# fleet-client

`fleet`, the command that shows the runs of taus on the tau service in the
fleet host (docs/fleet-core/tau/index.md), where each is, and what each
run's agent did. It loads no dsh module. Runs are started, finished and
released with tau's own command, `tau`, through its fleet adaptor (tau's
docs/spec/fleet.md), which talks to the same service.

## Provides

```
fleet list             list the runs: session, state, how each ended, tau
fleet status <run>     show a run as list does, then why it failed, if it
                       did, and its prompt
fleet history <run>    print the run's session's history, an event of dsh's
                       per line, whether it ended or not
```

- A run is named by its session's id, or by its id as `tau` prints it,
  `fleet:<session id>`.
- A run is `running` until its agent is done, then `ended`, and `finished`
  once a finish has given back how it ended, which it does again each time.
- `history` prints the run's session's history, so the caller can inspect
  what the agent did: dsh's session events, one JSON object per line,
  oldest first: the prompt, each request's system prompt and tools, each
  model message, tool call and result, and each turn's end. Its form is
  dsh's, not tau's spec's.
- Exit codes:
  - `0` on success;
  - `1` when the service refuses or fails, or there is no service;
  - `2` on a mistaken command line, with a pointer to `--help`.

A run's life is tau's:

```
tau run --adaptor fleet <tau-dir> --call <call.json>     start a run, wait for it, put its outputs, and release it
tau start --adaptor fleet <tau-dir> --call <call.json>   start a run, and print its id, fleet:<session id>
tau finish fleet:<session id>                            wait for its result, and put its outputs, as often as asked
tau release fleet:<session id>                           drop it: archive its session, and remove its box
```

`$TAU_ADAPTOR=fleet` makes the fleet adaptor the default. `tau` keeps each
run it started, where its outputs go, in its state folder until it is
released, so `finish` and `release` work from any folder; interrupting
`tau run` releases the run (tau's docs/spec/client.md).

## Design

- **The socket** is where tau's `defaultFleetSocket` finds it, as `tau`
  does: `$TAU_FLEET_SOCKET`, or `$DSH_HOME/fleet/tau.sock`, or
  `~/.dsh/fleet/tau.sock` when `DSH_HOME` is unset or blank, as dsh finds
  its home. Each command is one of the service's own requests, `list`,
  `status` or `history` (`@sleepymug/fleet-protocol/tau`), on a connection
  of its own, through tau's `fleetSocket`.
- **Nothing of a run's files** passes through `fleet`: tau's client packs
  a call, and its fleet adaptor checks a result and puts it at the
  caller's paths.

## Built on

- `@sleepymug/tau/adaptors`' `fleetSocket` and `defaultFleetSocket`.
- `@sleepymug/fleet-protocol/tau`, for the service's own requests.
- `node:util`'s `parseArgs`, for the command line.

## How it runs

With `pnpm exec dsh web` running, after `pnpm build` and
`pnpm image`, in a folder with `notes.md`, a folder `site`, and a folder
`out`:

```
$ alias fleet='node <checkout>/packages/fleet-client/lib/cli.js'
$ alias tau='node <checkout>/../agent_fleet_project/tau/dist/cli/main.js'
$ echo '{"files": {"notes": "notes.md", "site": "site", "report": "out/report.md"}, "args": {"style": "terse"}}' > call.json
$ tau start --adaptor fleet <checkout>/examples/demo --call call.json
fleet:session-4458…
$ fleet status session-4458…
session-4458…  running   -       demo
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
$ tau finish fleet:session-4458…
Added the notes to site/index.md.
$ fleet history session-4458… | head -1
{"type":"user/message",…}
$ tau release fleet:session-4458…
$ tau run --adaptor fleet <checkout>/examples/demo --call call.json
Added the notes to site/index.md.
```
