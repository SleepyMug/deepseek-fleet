# fleet-core/tools

fleet's model tools. Every session that works on the host, such as the
web UI's, whatever its agent preset, has `tau_run`, which runs a tau as
`tau run --adaptor fleet` does. A tau's session has none of fleet's own: it runs its
programs with bash's `node`, which import what its tau exposes
(docs/fleet-core/tau/index.md).

## Provides

`fleet-tau-tools` (`@sleepymug/fleet-core/tools/tau`), a dsh plugin that
fleet-core's `cordis.patch.yml` mounts at the top, not in an agent preset,
so every agent has what it registers, whatever its preset: one tool, and
a system-prompt section, `tool:tau`, which is tau's `TAU.md` as its tau
library has it, where the session has the tool, since the tool's
description says what `tau_run` does, not what a tau is:

| Tool | Takes | Gives |
|---|---|---|
| `tau_run` | `{ tau, files?, args?, history? }` | `{ sessionId, ok, text, failure? }`: the run's session, whether it succeeded, its agent's final text, and why it failed, if it did; with `history`, a path, the run's session's history written there. A call that does not fit the tau, one that writes where the session's sandbox does not let it, or a run that cannot start, is a tool error. |

## Design

### tau_run

- **A run is the session's,** as one from the host's `tau` is the host's:
  the tool runs it with tau's client and its fleet adaptor, over a
  transport in this process, `fleetLoopback`, to the tau service's
  requests as the session makes them, `ctx.fleetTau.handlerFor`
  (docs/fleet-core/tau/index.md), so `status` gives the session as the
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
  docs/spec/placeholders.md has them, which the tool's description leaves
  to TAU.md, the primer it adds to the system prompt.
- **Its history,** if `history` names a path, the session's working
  directory's if relative, is the run's session's history, as the
  service gives it (docs/fleet-core/tau/index.md): dsh's events, one JSON object per
  line, written there, its folder made if missing, before the result is
  put at its paths, whether the run succeeded or not.
- **It writes where the session's sandbox lets it,** as dsh's sandbox
  policy has it for the session (`ctx.sandboxPolicy.resolve`), which is
  what dsh's file tools fence a write by: under `danger-full-access`,
  anywhere; under `read-only`, nowhere, so a call with an `out` or `inout`
  file, or `history`, is refused; under `workspace-write`, under its
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
- **A tau's session does not have it:** it runs taus with its tau API, if
  its tau declares it (docs/fleet-ext-tau/index.md), whose files are its
  box's. The `tau` preset hides it, with every tool the host gives every
  session (docs/fleet-core/tau/index.md); and the tool itself refuses a
  tau's session, whose full access, which is its box's, would let it write
  the host's files.

## Built on

- `@sleepymug/tau`, for `tau_run`: its client, `createClient`, and its
  fleet adaptor, `createFleetAdaptor` and `fleetLoopback`.
- `ctx.fleetTau` (fleet-core/tau), for `tau_run`'s runs: `handlerFor`,
  and `untilEnded` and `history`, fleet's own.
- `ctx.fleetTauRuns` (fleet-core/tau), for which sessions are a tau's.
- `@deepseek-ai/dsh-sandbox` (`writableRoots`) and
  `@deepseek-ai/dsh-sandbox-policy`, for the session's sandbox.
- `@deepseek-ai/dsh-tools` (`defineTool`) and
  `@deepseek-ai/dsh-system-prompt`, which must be the copies the running
  dsh loaded: run the workspace's dsh, `pnpm exec dsh`.
