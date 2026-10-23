# fleet-client

`fleet`, the command that shows the runs of taus on the tau service in the
fleet host (docs/fleet-core/tau/index.md), and where each is. It loads no
dsh module. Runs are started, looked into, finished and released with
tau's own command, `tau`, through its fleet adaptor (tau's
docs/spec/fleet.md), which talks to the same service; what a run's agent
did is its trace, which `tau trace` prints.

## Provides

```
fleet list             list the runs: session, state, how each ended, tau
fleet status <run>     show a run as list does, then why it failed, if it
                       did, and its prompt
```

- A run is named by its session's id, or by its id as `tau` prints it,
  `fleet:<session id>`.
- A run is `running` until its agent is done, then `ended`, and `finished`
  once its result was first given back, which it is again each time.
- Exit codes:
  - `0` on success;
  - `1` when the service refuses or fails, or there is no service;
  - `2` on a mistaken command line, with a pointer to `--help`.

A run's life is tau's:

```
tau run --adaptor fleet <tau-dir> --call <call.json>     start a run, wait for it, put its outputs, and release it
tau start --adaptor fleet <tau-dir> --call <call.json>   start a run, and print its id, fleet:<session id>
tau status fleet:<session id>                            whether it is running or ended, and how, at once
tau trace fleet:<session id>                             what its agent did: its session's events, as dsh logs them
tau finish fleet:<session id>                            wait for its result, and put its outputs, as often as asked
tau release fleet:<session id>                           drop it: archive its session, and remove its box
```

`$TAU_ADAPTOR=fleet`, or `adaptor: fleet` in tau's config file,
`~/.config/tau/config.yaml`, makes the fleet adaptor the default. `tau` keeps each
run it started, where its outputs go, in its state folder until it is
released, so `finish` and `release` work from any folder; interrupting
`tau run` releases the run (tau's docs/spec/client.md).

## Design

- **The socket** is where tau's `defaultFleetSocket` finds it, as `tau`
  does: `$TAU_FLEET_SOCKET`, or `$DSH_HOME/fleet/tau.sock`, or
  `~/.dsh/fleet/tau.sock` when `DSH_HOME` is unset or blank, as dsh finds
  its home; not the socket tau's config file names, which `fleet` does
  not read. Each command is the service's own request, `list`
  (`@sleepymug/fleet-protocol/tau`), on a connection of its own, through
  tau's `fleetSocket`.
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
$ alias tau='node <checkout>/tau/dist/cli/main.js'
$ echo '{"files": {"notes": "notes.md", "site": "site", "report": "out/report.md"}, "args": {"style": "terse"}}' > call.json
$ tau start --adaptor fleet <checkout>/examples/demo --call call.json
fleet:session-4458…
$ fleet status session-4458…
session-4458…  running   -       demo
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
$ tau finish fleet:session-4458…
Added the notes to site/index.md.
$ tau trace fleet:session-4458… | head -2
{"format":"dsh-session-events"}
{"type":"user/message",…}
$ tau release fleet:session-4458…
$ tau run --adaptor fleet <checkout>/examples/demo --call call.json
Added the notes to site/index.md.
```
