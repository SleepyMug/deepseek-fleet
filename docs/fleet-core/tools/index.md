# fleet-core/tools

fleet's model tools. A session that works on the host, such as the web
UI's, has `tau_run`, which runs a tau as `fleet run` does. A tau's session
has none of fleet's own: it runs its programs with bash's `node`, which
import what its tau exposes (docs/fleet-core/tau/index.md).

## Provides

`fleet-tau-tools` (`fleet-core/tools/tau`), a dsh plugin that fleet-core's
`fleet` agent preset mounts. It registers one tool, and a system-prompt
section, `tool:tau`, which is tau's `TAU.md` as its tau library has it,
where the session has the tool, since the tool's description says what
`tau_run` does, not what a tau is:

| Tool | Takes | Gives |
|---|---|---|
| `tau_run` | `{ tau, files?, args?, history? }` | `{ sessionId, ok, text, failure? }`: the run's session, whether it succeeded, its agent's final text, and why it failed, if it did; with `history`, a path, the run's session's history written there. A call that does not fit the tau, or a run that cannot start, is a tool error. |

## Design

### tau_run

- **A run is the session's,** as one from `fleet` is the host's: the tool
  calls the tau service, `ctx.fleetTau` (docs/fleet-core/tau/index.md),
  with the session as the run's caller, so `status` gives the session as the
  run's `parent`, and the session reaches only the runs it started. The run's
  own session is in the session's working directory, its project, and the
  web UI lists it there.
- **Its files are the session's,** on the host: the tool packs the run's
  call from the session's working directory, where `tau` and relative paths
  in `files` resolve, as `fleet` does from its folder, and puts the result
  at the paths given, as tau's `packCall` and `applyResult` do. The call is
  tau's docs/spec/calls.md: `files`, a path for each file, or, for an `in`,
  a list of paths, and each extra file, one the tau does not declare, with
  its mode, `{ mode, path, kind? }`; and `args`, JSON that fits the tau's
  schema, whose strings hold placeholders as tau's
  docs/spec/placeholders.md has them, which the tool's description leaves
  to TAU.md, the primer it adds to the system prompt.
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

## Built on

- `@sleepymug/tau/call`, for `tau_run`: `packCall` and `applyResult`.
- `ctx.fleetTau` (fleet-core/tau), for `tau_run`'s runs.
- `@deepseek-ai/dsh-tools` (`defineTool`) and
  `@deepseek-ai/dsh-system-prompt`, which must be the copies the running
  dsh loaded: run the workspace's dsh, `pnpm exec dsh`.
