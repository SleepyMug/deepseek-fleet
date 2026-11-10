# dsh-tau-box

What dsh-tau puts in every box, as the package of its tau service
(docs/dsh-tau/tau/index.md), which the fleet host stages with the packages
it depends on, and copies into each box at `/opt/fleet/services/tau`
(docs/fleet/services/index.md): the `tau` command, whose runs go to
dsh-tau as the box's run's, and dsh-tau's half of a run's box, which sets
the box up from the run's call and packs its result. It also holds the
wire dsh-tau and its half share, and the backend's own requests' types,
for whoever asks them.

## Provides

- The bin `tau` (`lib/tau.js`): tau's command, `@sleepymug/tau/cli`, as
  tau has it (tau's docs/spec/client.md#the-tau-command), which the fleet
  host links on every box's PATH. The tau service's environment,
  `TAU_ADAPTOR=socket` and `TAU_SOCKET=/run/fleet/services/tau.sock`, has
  it run taus through its socket adaptor on the service's socket in the
  box, which the host relays to dsh-tau, so each run is the box's run's,
  its paths the box's: `tau run <dir> --call-json '<call>' --json`, `tau
  start`, `tau finish`, and the rest.
- `lib/box/main.js`, dsh-tau's half of a run's box (`box/endpoint.ts`), on
  tau's backend SDK, which dsh-tau runs through the fleet host's
  `box.pipe`, before the agent does, and which runs no code of the tau's:
  - `setup`, the run's call on its stdin, places the tau at `/tau/self`,
    admits the call against it, places each file, checks them, expands the
    args, the prompt and the init with the places, keeps the files and
    their places in `/tau/.run.json`, writes the run's context,
    `/tau/context.json`, `{ self, files, args }` (tau's
    docs/spec/context.md), links `/tau/node_modules` to
    `/tau/self/node_modules` if the tau has one, puts tau's `TAU.md` and
    `TAU_DEV.md` in `/tau`, and writes its report to stdout, as JSON;
  - `pack '{"outcome"}'` writes the run's result to stdout, as tau's
    backend SDK collects it, from what the agent left at each `out` and
    `inout` file's place, checked, or a failure, when that does not fit.

  Why one fails goes to stderr. `@sleepymug/dsh-tau-box/box/endpoint`
  exports both, each with the root the box's paths are under, for tests.
- `@sleepymug/dsh-tau-box/layout`, where a run has its things in its box,
  which the half owns and reports: `FOLDERS`, `/tau/in`, `/tau/workspace`
  and `/tau/out`; `SELF`, `/tau/self`; `PROGRAMS`, `/tau`, the program
  directory; `MODULES`, `/tau/node_modules`; `CONTEXT`, `/tau/context.json`, and `CONTEXT_VARIABLE`,
  `TAU_CONTEXT`; `RUN`, `/tau/.run.json`; `PRIMER` and `DEV_PRIMER`;
  `SERVICE`, `tau`, the service's name; and `placer()`, which gives each
  file its place, under its base name, in a folder of its own named for
  the file when that is taken.
- `@sleepymug/dsh-tau-box/protocol`, how dsh-tau and its half talk, which
  both import: `BOX_ENTRY`, `/opt/fleet/services/tau/lib/box/main.js`;
  `tauArgv(command)`, each command's line, on the box's Node, and
  `readTauCommand`, as the half reads it back; `requestSetup(pipe, call)`
  and `requestPack(pipe, outcome, output)`, which run a command through a
  `Pipe`, as the fleet host's `box.pipe` runs a program, with host files
  for its stdin and its stdout; `readSetup`, which takes the half's report
  once it has the shape of a `Setup`, `{ prompt, cwd, places, self,
  programs, init?, packages }`, every path absolute, each package of the
  tau's own it exposes with where it is and what it says it is.
- `@sleepymug/dsh-tau-box/runs`, the tau backend's own requests, beside a
  run's: `socketPath(dshHome)`, where the backend listens,
  `<dshHome>/tau/tau.sock`; and the types of `list`, `Request`, `Answers`,
  `RunStatus`, `RunState` and `Result`, a run's id its session's, its
  `parent` the run that started it, if one did, its prompt the tau's,
  expanded with where the box has each file, and its state `running`,
  `ended`, or `finished` once its result was first given back.

## Design

- **One package for the box.** Whatever dsh-tau needs in a box is here,
  so the box image holds nothing of tau's or dsh-tau's, and a box gets
  the version of the package dsh-tau runs with, as the fleet host copies
  it in when the box starts; a newer one reaches the boxes started after
  dsh-tau registers it again.
- **The half owns the layout.** dsh-tau takes where things are from the
  half's report, which runs on a call dsh-tau admitted, before the agent,
  and runs no code of the tau's, so dsh-tau takes it as its own once it
  has its shape; the result it packs comes from what the agent left, so
  dsh-tau reads it and checks it again (docs/dsh-tau/tau/index.md).
- **The `tau` command is tau's own**, configured by the service's
  environment, not by a file in the box: a tau's agent, or a program of
  its, runs taus as any caller does, and so does a tau's init.
- **Self-contained as installed.** The package and what it depends on,
  tau and its own dependencies, and fleet-protocol, are pure JavaScript,
  which the fleet host stages as installed, so a box runs what the host
  has.

## Built on

- `@sleepymug/tau`: its CLI, `@sleepymug/tau/cli`; the backend SDK,
  `createBackendSdk`; the core's `checkOutputs` and `kindAt`; `wire-tar`'s
  `unpackCall` and `packResult`; and its primers, `TAU.md` and
  `TAU_DEV.md`.
- `@sleepymug/fleet-protocol/layout`, for the helper's Node and where the
  fleet host puts a service's package in a box.
