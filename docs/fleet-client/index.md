# fleet-client

`fleet`, the command that starts runs of taus, shows where they are, waits
for how they ended, and cancels and deletes them, through the tau service in
the fleet host (docs/fleet-core/tau/index.md). It loads no dsh module.

## Provides

```
fleet start <tau-dir> [<name>=<value> | <name>:=<json>]...
                       start a run of the tau with these values, and print its
                       session's id, then the tau's prompt; the web UI lists
                       the session under this folder
fleet list             list the runs: session, state, how each ended, tau
fleet status <session-id>    show a run as list does, and why it failed, if it did
fleet finish <session-id>    wait until the run ends, then print the agent's
                             final text; why it failed goes to stderr
fleet cancel <session-id>    cancel the run's turn, which ends the run
fleet delete <session-id>    archive the run's session, remove its box, and forget it
fleet run <tau-dir> [<name>=<value> | <name>:=<json>]...
                       start a run and finish it; Ctrl-C cancels the run, and
                       Ctrl-C again leaves it running
```

- A run is `running` until its agent is done, then `ended`, and `finished`
  once `finish` has given back how it ended, which it does again each time.
- `finish` and `run` report a run as tau's docs/spec/results.md has it: the
  final text on stdout, and why the run failed on stderr. By then, a run
  that succeeded has put what it left at its `$out` and `$inout` handles at
  their paths, a folder merging into one there; a run that failed has put
  nothing there.
- Exit codes:
  - `0` on success;
  - `1` when the run failed, when the service refuses or fails, or there is
    no service;
  - `2` on a mistaken command line, with a pointer to `--help`.

## Design

- **Values** (`values.ts`) come from the tau's `tau.json`, which `start`
  and `run` read with tau's library:
  - `<name>=<value>` gives a text, or, for a parameter whose type is a
    `file`, a `dir` or a `path`, a handle of the mode the type declares, to
    the path `<value>`, as `{"$in": "<value>"}`;
  - `<name>:=<json>` gives any value as JSON, as tau's docs/spec/values.md
    has them: a list, a record, or a handle written out.

  The service checks the values against the tau, so a name the tau does not
  declare passes as a text, for the service to refuse.
- **Paths.** `start` sends the tau's directory, absolute, and this folder,
  which relative paths in the values are relative to, and which is the
  session's workspace in dsh.
- **The socket** (`connection.ts`) is `$DSH_HOME/fleet/tau.sock`, or
  `~/.dsh/fleet/tau.sock` when `DSH_HOME` is unset or blank, as dsh finds its
  home. Each command is one request on a connection of its own.
- **Waiting.** `finish` holds its connection until the run ends. If the
  service goes away first, as when dsh restarts, the run is still there, so
  it says so once, waits for the service to come back, checking every
  second, and asks again.
- **`run`** is `start`, then `finish`, with the session's id on stderr. The
  first Ctrl-C cancels the run and goes on waiting, for the run to end as
  cancelled; the second leaves at once, with exit code 130, and the run as
  it is.

## Built on

- `@sleepymug/tau`'s `loadTau`, for the tau's parameters.
- `fleet-protocol/tau`, for the wire.
- `node:util`'s `parseArgs`, for the command line.

## How it runs

With `pnpm exec dsh --profile fleet` running, after `pnpm build` and
`pnpm image`, in a folder with `notes.md`, a folder `site`, and a folder
`out`:

```
$ alias fleet='node <checkout>/packages/fleet-client/lib/cli.js'
$ fleet start <checkout>/examples/demo style=terse notes=notes.md site=site report=out/report.md
session-4458…
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
$ docker exec fleet-tau-4458… find /tau
/tau
/tau/out
/tau/in
/tau/in/notes.md
/tau/self
/tau/self/PROMPT.md
/tau/self/tau.json
/tau/workspace
/tau/workspace/site
/tau/workspace/site/index.md
$ fleet list
session-4458…  running   -       <checkout>/examples/demo
$ fleet finish session-4458…
Added the notes to site/index.md.
$ fleet delete session-4458…
$ fleet run <checkout>/examples/demo style=terse notes=notes.md site=site report=out/report.md
fleet: started session-9c1e…
Added the notes to site/index.md.
```
