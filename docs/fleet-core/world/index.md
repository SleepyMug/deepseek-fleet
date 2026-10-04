# fleet-core/world

`ctx.fs` and `ctx.subprocess` for the fleet profile. A tau's session works
on the files of its box and runs its processes there; every other session,
such as one the web UI starts, and every call that is no session's work,
works on the host, through dsh's own local implementations.

## Provides

Two dsh services, which fleet-core's `cordis.patch.yml` mounts in place of
dsh's local ones (it disables dsh-base's `subprocess` row, and inserts no
`fs-local`):

| Row | Module | Service |
|---|---|---|
| `fleet-fs` | `fleet-core/world/fs` | `ctx.fs`, a `FileSystem` |
| `fleet-subprocess` | `fleet-core/world/subprocess` | `ctx.subprocess`, a `SubprocessRuntime` |

## Design

- **Whose call it is** (`caller.ts`): the session of the agent whose turn
  makes the call (`ctx.agents.currentInitiator()`), or else of the agent
  whose scoped context the caller reached the service through, as dsh's
  terminal controller reaches `ctx.subprocess` through `agent.ctx`. A call
  is a box's when that session is a tau's, which the runs of taus know at
  once (`ctx.fleetTauRuns.isTau`, docs/fleet-core/tau/index.md).
- **The host's side** is dsh's own `LocalFileSystem` and
  `LocalSubprocessRuntime`, which each service mounts in a context that
  isolates its service's name, so that only it sees them, and they do not
  stand in for it.
- **The box** of a session comes from `ctx.fleetTauRuns.boxFor`, which
  starts it if it is not running, as after a restart or `fleet stop`. Its
  helper serves every call (docs/fleet-image/helper/index.md).
- **Files.** A call that names a path, `resolve` and `lstat`, goes to the
  box of the session it is for, if a tau's. The targets the box gives are
  keyed `fleet-box://<session><path>`, with the plain path in the box as
  their display and process paths, so a call that takes a target goes where
  its key says, whoever makes it. A box's text streams in one chunk. Its
  failures are `FsError`s: the helper's code, or `FS_IO_ERROR`.
- **Processes.** A tau's session's process runs in its box, in a process
  group of its own, in the folder dsh names: the caller's folder, which the
  box has, empty, at the same path. It serves what dsh's bash asks: stdin
  ignored or given as data, and stdout and stderr collected into dsh's own
  in-memory tails (`OutputCollector`) as the helper sends them. Terminating
  it, or aborting its signal, ends its group, and so does this service's
  unloading. `resolveExecutable` asks the box's helper (`which`).

## Not yet

- **No spill files** for a box's output: a spill would sit on the host,
  where the session's file tools do not look, so bash says the full output
  is unavailable.
- **Not served for a box:** raw pipes, the control channel, terminals (the
  sidebar's terminal of a tau's session fails rather than open on the host)
  and watching.
- **The file viewer** makes calls that are no session's work, so for a
  tau's session it shows the host's folder, not its box.
- **dsh's other host features** stay on the host: spilled tool results,
  `@` file mentions and the changed-files card read the host's files.

## Built on

- `@deepseek-ai/dsh-fs` and `@deepseek-ai/dsh-subprocess`, whose
  `FileSystem` and `SubprocessRuntime` the services extend.
- `@deepseek-ai/dsh-fs-local` and `@deepseek-ai/dsh-subprocess-local`, for
  the host's side, and the latter's `OutputCollector`.
- `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-scope`, for whose call it
  is.
- `ctx.fleetTauRuns` (fleet-core/tau), and `Box` (fleet-core/box) through it.

These are runtime imports, so they must be the copies the running dsh
loaded: run the workspace's dsh, `pnpm exec dsh`.

## How it runs

With fleet-core in the fleet profile's bundles, `pnpm exec dsh --profile
fleet` mounts both services. After `fleet create` and `fleet start`
(docs/fleet-client/index.md), the session's bash and file tools work in its
box:

```
$ docker exec fleet-tau-4458… cat /tau/out/report.md   # written by the model's `write`
Added a line to index.md.
```
