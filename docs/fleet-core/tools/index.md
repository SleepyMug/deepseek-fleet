# fleet-core/tools

fleet's model tools. A tau's session has the TypeScript tools, `ts_modules`
and `ts_execute`: the model writes a program over what its tau exposes, the
tau's APIs and the packages of its own built on them, and runs it in the
session's box. Each API there runs the client of the extension that
implements it (docs/fleet-core/ext/index.md). Any other session, such as the
web UI's, works on the host and has `tau_run`, which runs a tau as `fleet
run` does.

## Provides

`fleet-ts-tools` (`fleet-core/tools/ts`), a dsh plugin that fleet-core's
`tau` agent preset mounts. It registers the two tools, and a system-prompt
section on how to use them:

| Tool | Takes | Gives |
|---|---|---|
| `ts_modules` | `{ query? }` | What a program may import: each `{ specifier, packageRoot, description }`, `packageRoot` the package's folder in the box, whose `package.json` and declarations the model reads. |
| `ts_execute` | `{ source, cwd?, input? }` | `{ value, stdout, stderr, durationMs }`: what the program's `main(input)` returned, and all it wrote. A type error, or the program's failure, is a tool error carrying its name, message, TypeScript's diagnostics or the program's stack, and the output. |

`fleet-tau-tools` (`fleet-core/tools/tau`), a dsh plugin that fleet-core's
`fleet` agent preset mounts. It registers one tool, and a system-prompt
section, `tool:tau`, which is tau's `TAU.md` as its tau library has it,
where the session has the tool, since the tool's description says what
`tau_run` does, not what a tau is:

| Tool | Takes | Gives |
|---|---|---|
| `tau_run` | `{ tau, values?, history? }` | `{ sessionId, ok, text, failure? }`: the run's session, whether it succeeded, its agent's final text, and why it failed, if it did; with `history`, a path, the run's session's history written there. Values that do not fit the tau, or a run that cannot start, are a tool error. |

## Design

### The TypeScript tools

- **What a program imports** is what the tau exposes, as the session's
  registry entry records it (docs/fleet-core/tau/index.md): `@api/<name>`,
  or a package's name, each with its folder in `/tau/node_modules`, which
  the run linked. `ts_modules` lists them, filtered by the query, from the
  entry, without the box. What is not exposed resolves too, through the
  same folder: exposing is no security boundary.
- **A program runs in the box,** through the helper's `ts.execute`
  (docs/fleet-box-runtime/helper/index.md), with ts-executor, which the image
  carries. ts-executor writes the program in a run folder below `/tau`
  (`/tau/.ts-executor/runs/`), so Node finds `/tau/node_modules` above it,
  and TypeScript does too. It type-checks the program, strictly, with each
  API typed by the tau's own declarations and Node's types as the image has
  them, then runs `main(input)` in a fresh Node process, in `cwd`: the
  session's working directory, `/tau/workspace`, unless the model names
  another.
- **Cancelling** the tool call sends `ts.cancel`, which ends the program's
  whole process group.
- **No limits** on how long a program runs, or how much it writes and
  returns, as there is none on what bash runs in the foreground; dsh's
  tool-result pruner shortens old results.
- **Only a tau's session** has the tools: the `tau` preset mounts them, and
  a call from another session fails.

### tau_run

- **A run is the session's,** as one from `fleet` is the host's: the tool
  calls the tau service, `ctx.fleetTau` (docs/fleet-core/tau/index.md),
  with the session as the run's caller, so `status` gives the session as the
  run's `parent`, and the session reaches only the runs it started. The run's
  own session is in the session's working directory, its project, and the
  web UI lists it there.
- **Its files are the session's,** on the host: the tool packs the run's
  call from the session's working directory, where `tau` and relative paths
  in `values` resolve, as `fleet` does from its folder, and puts the result
  at the paths given, as tau's `packCall` and `applyResult` do. The values
  are tau's docs/spec/values.md: a text, a handle, `{ "$in" | "$out" |
  "$inout": path }`, or lists and records of these.
- **Its history,** if `history` names a path, the session's working
  directory's if relative, is the run's session's history, as a `finish`
  gives it (docs/fleet-core/tau/index.md): dsh's events, one JSON object per
  line, written there, its folder made if missing, before the result is
  put at its paths, whether the run succeeded or not.
- **It waits for the run,** so nothing outlives the call, as bash in the
  `fleet` preset runs only in the foreground. Cancelling the call cancels
  the run, which then gives back nothing. Several calls in one turn run at
  once (`isConcurrencySafe`): each run has a box of its own, and what each
  gives back goes where the model said.
- **A tau's session does not have it:** it runs taus with its tau API, if
  its tau declares it (docs/fleet-ext-tau/index.md), whose files are its
  box's.

## Not yet

- The tools show the whole output and value, however large.
- Nothing presents what a tau exposes before the model calls `ts_modules`;
  the prompt section says to.

## Built on

- `@sleepymug/tau/call`, for `tau_run`: `packCall` and `applyResult`.
- `ctx.fleetTau` (fleet-core/tau), for `tau_run`'s runs.
- `@deepseek-ai/dsh-tools` (`defineTool`) and
  `@deepseek-ai/dsh-system-prompt`, which must be the copies the running
  dsh loaded: run the workspace's dsh, `pnpm exec dsh`.
- `ctx.fleetTauRuns` (fleet-core/tau), for the session's entry and box.
- The helper's `ts.execute` and `ts.cancel`, with `@sleepymug/ts-executor`
  in the image.
