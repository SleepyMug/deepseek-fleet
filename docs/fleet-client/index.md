# fleet-client

`fleet`, the command that sets up boxes for runs of taus, and starts, stops
and deletes their sessions, through the tau service in the fleet host
(docs/fleet-core/tau/index.md). It loads no dsh module.

## Provides

```
fleet create <tau-dir> [<name>=<value> | <name>:=<json>]...
                       set up a box for a run of the tau with these values,
                       and print the session's id, then the tau's prompt
fleet start <session-id>     start the session's box; the first start makes the
                             session, which the web UI lists under this folder,
                             and gives it the tau's prompt
fleet stop <session-id>      cancel the session's turn, and stop its box
fleet delete <session-id>    archive the session, remove its box, and forget it
```

- Exit codes:
  - `0` on success;
  - `1` when the service refuses or fails, or there is no service;
  - `2` on a mistaken command line, with a pointer to `--help`.

## Design

- **Values** (`values.ts`) come from the tau's `tau.json`, which `create`
  reads with tau's library:
  - `<name>=<value>` gives a text, or, for a parameter whose type is a
    `file`, a `dir` or a `path`, a handle of the mode the type declares, to
    the path `<value>`, as `{"$in": "<value>"}`;
  - `<name>:=<json>` gives any value as JSON, as tau's docs/spec/values.md
    has them: a list, a record, or a handle written out.

  The service checks the values against the tau, so a name the tau does not
  declare passes as a text, for the service to refuse.
- **Paths.** `create` sends the tau's directory, absolute, and this folder,
  which relative paths in the values are relative to, and which is the
  session's workspace in dsh.
- **The socket** (`connection.ts`) is `$DSH_HOME/fleet/tau.sock`, or
  `~/.dsh/fleet/tau.sock` when `DSH_HOME` is unset or blank, as dsh finds its
  home. Each command is one request on a connection of its own.

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
$ fleet create <checkout>/examples/demo style=terse notes=notes.md site=site report=out/report.md
session-4458…
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
$ fleet start session-4458…      # the web UI lists the session under this folder
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
$ fleet stop session-4458…
$ fleet delete session-4458…
```
