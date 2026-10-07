# fleet-client

`fleet`, the command that starts runs of taus, shows where they are, waits
for how they ended, and cancels and deletes them, through the tau service in
the fleet host (docs/fleet-core/tau/index.md). It loads no dsh module.

## Provides

```
fleet start <tau-dir> [<call>]...
                       start a run of the tau with this call, and print its
                       session's id, then the tau's prompt; the web UI lists
                       the session under this folder
fleet list             list the runs: session, state, how each ended, tau
fleet status <session-id>    show a run as list does, and why it failed, if it did
fleet finish [--history <file>] <session-id>
                       wait until the run ends, put what it gave back at the
                       paths it was given, then print the agent's final text;
                       why it failed goes to stderr; --history writes the
                       run's session's history to <file>
fleet cancel <session-id>    cancel the run's turn, which ends the run
fleet delete <session-id>    archive the run's session, remove its box, and forget it
fleet run [--history <file>] <tau-dir> [<call>]...
                       start a run and finish it, as finish does; Ctrl-C
                       cancels the run, and Ctrl-C again leaves it running
```

- A run is `running` until its agent is done, then `ended`, and `finished`
  once `finish` has given back how it ended, which it does again each time.
- `finish` and `run` report a run as tau's docs/spec/results.md has it: the
  final text on stdout, and why the run failed on stderr. By then, for a
  run that succeeded, they have put what it left at its `out` and `inout`
  files at their paths, a folder merging into one there; a run that
  failed puts nothing there. A `finish` asked again puts the same again.
- `--history <file>`, with `finish` and `run`, writes the run's session's
  history to `<file>`, its folder made if missing, failed run or not, so
  the caller can inspect what the agent did: dsh's session events, one JSON
  object per line, oldest first: the prompt, each request's system prompt
  and tools, each model message, tool call and result, and each turn's
  end. Its form is dsh's, not tau's spec's. It is written before the
  result is put at its paths.
- Exit codes:
  - `0` on success;
  - `1` when the run failed, when the service refuses or fails, or there is
    no service;
  - `2` on a mistaken command line, with a pointer to `--help`.

## Design

- **The call** (`call.ts`), its files and args, as tau's
  docs/spec/calls.md has them, comes from the command line, by the files
  the tau's `tau.json` declares, which `start` and `run` read with tau's
  library:
  - `<name>=<value>` gives the file `<name>` the path `<value>`, when the
    tau declares that file, and else the arg `<name>` the string `<value>`;
  - `<name>:=<json>` gives either as JSON: a file a path, or, for an `in`,
    a list of paths; an arg any JSON;
  - `--in`, `--out` or `--inout`, then `<name>=<path>` or `<name>:=<json>`,
    gives a file with that mode, `{"mode", "path"}`, which is how a call
    gives the tau's agent an extra file, one the tau does not declare, as
    `fleet run best-of --in inner=shout --out report=out/report.txt …`.

  A name the tau does not declare as a file passes as an arg, unless an
  option gives it a mode, for the tau's schema to take or refuse. In a
  string of the args, `${<file>}` is where the tau's agent sees that file,
  as in `'start=${site}/index.html'`, and `$${<file>}` passes `${<file>}`
  on, for a run the agent makes.
- **Calls and results** (`runs.ts`, exported as `fleet-client/runs`, which
  fleet-trace uses too). `start` packs the run's call here, with tau's
  `packCall`: it reads the tau, checks the call and the paths it names
  against it, as a runtime would, and sends the call, which carries the
  tau and the content of each `in` and `inout` file, with the name of the tau's
  directory, which titles the run, this folder, which is the session's
  workspace in dsh, and the targets, this side's path of each `out` and
  `inout` file. Relative paths are this folder's. `finish` gets the
  targets back with the run's result, and puts what the result holds at
  them, with tau's `applyResult`, trusting the service as to what goes
  where; so any `finish`, in any folder, can finish a run another process
  started. The history comes in `finish`'s answer, and is written here
  too. The service reads and writes none of these files.
- **The socket** (`connection.ts`) is `$DSH_HOME/fleet/tau.sock`, or
  `~/.dsh/fleet/tau.sock` when `DSH_HOME` is unset or blank, as dsh finds its
  home. Each command is one request on a connection of its own; `start`
  sends the call after its line, and ends what it sends, and `finish` reads
  the result after its answer.
- **Waiting.** `finish` holds its connection until the run ends. If the
  service goes away first, as when dsh restarts, the run is still there, so
  it says so once, waits for the service to come back, checking every
  second, and asks again.
- **`run`** is `start`, then `finish`, with the session's id on stderr. The
  first Ctrl-C cancels the run and goes on waiting, for the run to end as
  cancelled; the second leaves at once, with exit code 130, and the run as
  it is.

## Built on

- `@sleepymug/tau`'s `loadTau`, for the tau's files, and
  `@sleepymug/tau/call`'s `packCall` and `applyResult`.
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
