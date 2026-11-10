# dsh-tau/tools

dsh-tau's model tools. Every session that works on the host, such as the
web UI's, whatever its agent preset, has `tau_run`, which runs a tau as
`tau run --adaptor socket` does. A tau's session has none of dsh-tau's
own: it runs its programs with bash's `node`, and taus with the `tau`
command in its box (docs/dsh-tau/tau/index.md).

## Provides

`fleet-tau-tools` (`@sleepymug/dsh-tau/tools/tau`), a dsh plugin that
dsh-tau's `cordis.patch.yml` mounts at the top, not in an agent preset,
so every agent has what it registers, whatever its preset: one tool; tau's
primers, as its tau library has them, as two dsh skills (`primers.ts`):
`tau`, its `TAU.md`, what a tau takes and what a run of one promises, and
`tau-dev`, its `TAU_DEV.md`, how to make one; and a system-prompt section,
`tool:tau`, where the session has the tool, which says it runs taus, and
to load `tau` before running one and `tau-dev` before making one:

| Tool | Takes | Gives |
|---|---|---|
| `tau_run` | `{ tau, files?, args?, trace? }` | `{ sessionId, ok, text, failure? }`: the run's session, whether it succeeded, its agent's final text, and why it failed, if it did; with `trace`, a path, the run's trace written there. A call that does not fit the tau, one that writes where the session's sandbox does not let it, or a run that cannot start, is a tool error. |

## Design

### tau_run

- **A run is the session's,** as one from the host's `tau` is the host's:
  the tool runs it with tau's client and its socket adaptor, over a
  transport in this process, `loopbackTransport`, to the tau backend's
  requests as the session makes them, `ctx.fleetTau.handlerFor`
  (docs/dsh-tau/tau/index.md), so `list` gives the session as the
  run's `parent`, and the session reaches only the runs it started. The
  run's own session is in the session's working directory, its project,
  and the web UI lists it there.
- **Its files are the session's,** on the host: tau's client packs the
  run's call from the session's working directory, where `tau` and
  relative paths in `files` resolve, as the `tau` command does from its
  folder, and its adaptor checks the result and puts it at the paths
  given. The call is
  tau's docs/spec/calls.md: `files`, a path for each file, or, for an `in`,
  a list of paths, and each extra file, one the tau does not declare, with
  its mode, `{ mode, path, kind? }`; and `args`, JSON that fits the tau's
  schema, whose strings hold placeholders as tau's
  docs/spec/placeholders.md has them.
- **Its description says what a call is in `TAU.md`'s terms**, and what
  dsh-tau does that `TAU.md` leaves to a runtime: the run's agent is in a
  container of its own, with copies of the files, and cannot ask anything;
  its session is archived; a file it gave back replaces one at the path,
  and a directory merges into one there, so what the agent removed from it
  stays; a failed run changes none of the paths, though what the commands
  of its container's services did stands; and calls in one message run at
  once, so each needs its own `out`
  and `inout` paths. Its parameters say what the `tau` skill does of the
  call's parts: the tau's directory, whose `PROMPT.md` and `tau.json` to
  read first; each file's path, an `out`'s folder existing; and that an
  arg names a file only by its placeholder, the agent seeing none of the
  session's paths.
- **tau's primers are skills**, which a session loads when it needs them,
  rather than a section of every prompt: the runtime skills `tau` and
  `tau-dev`, registered at the top, in dsh's skill registry, each the
  file's text. A tau's session does not list them: the `tau` preset
  shadows them, and its box has the files (docs/dsh-tau/tau/index.md).
- **Its trace,** if `trace` names a path, the session's working
  directory's if relative, is the run's trace, its session's events, as
  the service gives it (docs/dsh-tau/tau/index.md), written there as
  `tau trace` prints it, a line naming its format, then an event a line,
  its folder made if missing, before the result is put at its paths,
  whether the run succeeded or not.
- **It writes where the session's sandbox lets it,** as dsh's sandbox
  policy has it for the session (`ctx.sandboxPolicy.resolve`), which is
  what dsh's file tools fence a write by: under `danger-full-access`,
  anywhere; under `read-only`, nowhere, so a call with an `out` or `inout`
  file, or `trace`, is refused; under `workspace-write`, under its
  writable roots, the session's folder and the temporary folders, as
  dsh's `writableRoots` has them. Each path is compared as far as it is
  there, its links resolved, the rest as it is, which is where tau puts a
  result: it replaces the path, and follows no link below it. The tool
  checks with tau's `check`, before the run starts, and again once the
  service says the run ended, before it finishes it and writes anything,
  since the sandbox, or a link, may have changed meanwhile. It asks for no wider access, as dsh's tools may; what it
  reads, the tau and the `in` files, every mode reads.
- **It waits for the run, and releases it,** so nothing outlives the call:
  once the run is finished, or the call cancelled, or refused as it ends,
  the run is released, its session archived and its box removed, and a
  cancelled run gives back nothing. Several calls in
  one turn run at once (`isConcurrencySafe`): each run has a box of its
  own, and what each gives back goes where the model said.
- **A tau's session does not have it:** it runs taus with the `tau`
  command in its box, the tau service's (docs/dsh-tau/tau/index.md), whose
  files are its box's. The `tau` preset hides it, with every tool the host gives every
  session (docs/dsh-tau/tau/index.md); and the tool itself refuses a
  tau's session, whose full access, which is its box's, would let it write
  the host's files.

## Built on

- `@sleepymug/tau`, for `tau_run`: its client, `createClient`, and its
  socket adaptor, `createSocketAdaptor` and `loopbackTransport`.
- `ctx.fleetTau` (dsh-tau/tau), for `tau_run`'s runs: `handlerFor`,
  and `untilEnded`, the backend's own, which waits for the run's end in this
  process rather than asking its status.
- `ctx.fleetTauRuns` (dsh-tau/tau), for which sessions are a tau's.
- `@deepseek-ai/dsh-sandbox` (`writableRoots`) and
  `@deepseek-ai/dsh-sandbox-policy`, for the session's sandbox.
- `@deepseek-ai/dsh-tools` (`defineTool`) and
  `@deepseek-ai/dsh-system-prompt`, which must be the copies the running
  dsh loaded: run the workspace's dsh, `pnpm exec dsh`.
