# fleet-core/world

`ctx.fs` and `ctx.subprocess` for the fleet profile. A tau's session works
on the files of its box and runs its processes there, and the web UI's
sidebar shows that box: its file tree, previews and live refresh, and its
terminal. Every other session, such as one the web UI starts, works on the
host, through dsh's own local implementations.

## Provides

Two dsh services, which fleet-core's `cordis.patch.yml` mounts in place of
dsh's local ones (it disables dsh-base's `subprocess` row, and inserts no
`fs-local`). The patch also turns off dsh's spill files (`spill-policy`,
`spill-local`), which would put oversized tool results on the host, where
a tau's session does not look; they stay inline instead.

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
  starts it if it is not running, as after a restart or the run's end. Its
  helper serves every call (docs/fleet-box-runtime/helper/index.md).
- **Files.** A call that names a path, `resolve` and `lstat`, goes to the
  box its path or its `cwd` names, written `fleet-box://<session><path>`,
  or else to the box of the session it is for, if a tau's. The targets a box
  gives are keyed the same way, with the plain path in the box as their
  display and process paths, so a call that takes a target goes where its
  key says, whoever makes it. A box's text streams in one chunk. Its
  failures are `FsError`s: the helper's code, or `FS_IO_ERROR`.
- **One box per session.** A tau's session's own work may name only its own
  box; another's is `FS_PERMISSION_DENIED`, so a model in a box never
  reaches another box. Any other caller works on the host already, and may
  name any box.
- **The sidebar's files.** dsh's file viewer finds a session's folder
  through the `workspaceFileScope` lookup, which `fleet-fs` configures: a
  tau's session's is `fleet-box://<session>/tau`, its box's tau folders
  (`in`, `out`, `self`, `workspace`); any other's is what dsh gives, the
  session's folder, or the sandbox policy's root. The viewer passes the
  folder on to every call, as the path or the `cwd`, so its tree, previews
  and the chat's file links read the box.
- **Attachments.** dsh asks the file system where a host file is in the
  world of the session it works for (`processPathFromHostPath`), to tell
  its model where an attachment of dsh's store is: the normalized copy of
  an image it was shown, which its model can work on or look at again with
  `read_image` once the image is left out of a request, or a file uploaded
  to it, which it reads only there. For a tau's session, a file of the
  store, `$DSH_HOME/attachments/`, is at the same place under
  `/fleet/attachments` in its box, such as
  `/fleet/attachments/v1/files/49/<sha256>/notes.csv`; the store's files
  never change, so a copy stays the same file. The answer comes at once,
  and the runs copy the file in then, once per session, readable by all
  and writable by none (`copyInOnce`, docs/fleet-core/tau/index.md). The
  copy is one of the session's operations on its box, so the box's next
  use, which every file call, process and terminal waits for, comes after
  it; and the model acts on the answer only after the request it is in.
  Any other host file is not in a tau's session's world. Every other
  session gets dsh's own answer, the host path. The service's config names
  the dsh home, as `dshHomePath()` in the patch.
- **Watching** a box's target asks its helper (`fs.watch`), which watches
  with dsh's local file system and sends an event for each change, until
  the watch's stop or signal ends it (`fs.unwatch`). A box lost meanwhile
  is the watch's error. So the sidebar refreshes live.
- **Processes.** A tau's session's process runs in its box, in a process
  group of its own, in the folder dsh names, the session's project, a host
  folder, put in `/tau/workspace` in the box (`ctx.fleetTauRuns.boxPath`,
  docs/fleet-core/tau/index.md), as is a terminal's, and a file call's path
  or `cwd` in the project. It serves what dsh's bash asks: stdin
  ignored or given as data, and stdout and stderr collected into dsh's own
  in-memory tails (`OutputCollector`) as the helper sends them. Terminating
  it, or aborting its signal, ends its group, and so does this service's
  unloading. `resolveExecutable` asks the box's helper (`which`).
- **Terminals** (`terminal.ts`). dsh's terminal controller reaches
  `ctx.subprocess` through the session's agent, so a tau's session's
  sidebar terminal opens in its box: the helper runs the shell, the image's
  bash, on a pseudo-terminal there, and relays input, output and size. It
  reads the terminal's foreground process group from the kernel, which it
  signals, and ends the terminal's whole session, background jobs included,
  SIGHUP and SIGTERM, then SIGKILL after the grace period. It does not watch
  the shell for prompts, so activity is unknown and never `idle`.

## Not yet

- **No spill files** for anyone: bash says a box process's full output is
  unavailable, and big tool results stay inline.
- **Not served for a box:** raw pipes and the control channel.
- **A terminal is no session activity:** archiving a tau's session does not
  wait for its open terminals, and does not end them; deleting it removes
  the box, which does.
- **dsh's other host features** stay on the host: `@` file mentions and the
  changed-files card read the host's folder of a tau's session.

## Built on

- `@deepseek-ai/dsh-fs` and `@deepseek-ai/dsh-subprocess`, whose
  `FileSystem` and `SubprocessRuntime` the services extend.
- `@deepseek-ai/dsh-fs-local` and `@deepseek-ai/dsh-subprocess-local`, for
  the host's side, and the latter's `OutputCollector`.
- `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-scope`, for whose call it
  is.
- `@deepseek-ai/dsh-api-workspace-files` and `@deepseek-ai/dsh-typert-protocol`,
  for the `workspaceFileScope` lookup.
- `ctx.fleetTauRuns` (fleet-core/tau), and `Box` (fleet-core/box) through it.
- dsh's attachment store's layout, `$DSH_HOME/attachments/`, whose files
  `@deepseek-ai/dsh-attachment-local` names.

These are runtime imports, so they must be the copies the running dsh
loaded: run the workspace's dsh, `pnpm exec dsh`.

## How it runs

With fleet-core in the fleet profile's bundles, `pnpm exec dsh --profile
fleet` mounts both services. After `fleet start`
(docs/fleet-client/index.md), the session's bash and file tools work in its
box:

```
$ docker exec fleet-tau-4458… cat /tau/out/report.md   # written by the model's `write`
Added a line to index.md.
```

A file uploaded to the session in the web UI, and an image its model was
shown, are in its box where dsh tells the model they are:

```
$ docker exec fleet-tau-4458… ls -l /fleet/attachments/v1/files/49/492d…/
-r--r--r-- 1 node node 8 Oct  4 18:47 notes.csv
```
