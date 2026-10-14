# fleet-core/world

The world of a host fleet-core is installed in. A tau's session works on
the files of its box and runs its processes there, and the web UI's
sidebar shows that box: its file tree, previews and live refresh, and its
terminal. Every other session, such as one the web UI starts, works on the
host, through dsh's own implementations, its sandbox included, as if
fleet-core were not there.

## Provides

Five dsh services. Three are what dsh's web UI and host plane reach for a
session, whatever its agent preset, which fleet-core's `cordis.patch.yml`
mounts in place of dsh-base's rows: it disables `fs-sandbox`, `subprocess`
and `spill-local`, and each service mounts the module of the row it
replaces for every call that is not a box's.

| Row | Module | Service |
|---|---|---|
| `fleet-fs` | `@sleepymug/fleet-core/world/fs` | `ctx.fs`, a `FileSystem`, dsh's sandboxed one for the host |
| `fleet-subprocess` | `@sleepymug/fleet-core/world/subprocess` | `ctx.subprocess`, a `SubprocessRuntime`, dsh's local one for the host |
| `fleet-spill` | `@sleepymug/fleet-core/world/spill` | `ctx.spillStore`, a `SpillStore`, dsh's local one for the host |

Two are the `tau` agent preset's own (docs/fleet-core/tau/index.md), in
its `box` group, which isolates `fs`, `subprocess` and `shell`, so only the
preset's tools reach them, with dsh's local bash over them as their
`shell`:

| Row | Module | Service |
|---|---|---|
| `box-fs` | `@sleepymug/fleet-core/world/box-fs` | `ctx.fs` of the boxes, and of nothing else |
| `box-subprocess` | `@sleepymug/fleet-core/world/box-subprocess` | `ctx.subprocess` of the boxes, and of nothing else |

`fleet-fs` and `fleet-subprocess` are these two, with the host's side
added.

## Design

- **Whose call it is** (`caller.ts`): the session of the agent whose turn
  makes the call (`ctx.agents.currentInitiator()`), or else of the agent
  whose scoped context the caller reached the service through, as dsh's
  terminal controller reaches `ctx.subprocess` through `agent.ctx`. A call
  is a box's when that session is a tau's, which the runs of taus know at
  once (`ctx.fleetTauRuns.isTau`, docs/fleet-core/tau/index.md).
- **The host's side** is dsh's own `SandboxedFileSystem`,
  `LocalSubprocessRuntime` and `LocalSpillStore`, the modules of the rows
  fleet-core disables, which each service mounts in a context that
  isolates its service's name, so that only it sees them, and they do not
  stand in for it. A host call is theirs as dsh makes it: a file write
  with its sandbox policy, which dsh's file tools resolve for the session,
  and `fleet-fs` reports the sandbox mode the sandboxed file system does,
  dsh's default, so the tools offer wider access as they would; a process
  as dsh's sandboxed bash confines it. A session that is not a tau's has
  its sandbox, its approvals and its permission presets as dsh has them.
- **The preset's own world.** dsh's web UI and host plane reach the
  services the patch mounts at the top, never a preset's, so those serve a
  tau's session from its box and every other from the host. The tools of a
  tau's session reach the `box` group's instead, which have only the
  boxes: a path that is no box's is `FS_NOT_FOUND`, and a process of a
  session that is not a tau's is refused. So a session a person gives the
  `tau` preset in the web UI reaches nothing of the host through its tools,
  and dsh's local bash, unconfined, as a box needs, runs only in a box.
  Neither has a sandbox mode, so the tools offer no wider access: a box is
  its session's to change.
- **The box** of a session comes from `ctx.fleetTauRuns.hold`, which
  starts it if it is not running, as after a restart, the run's end or an
  idle stop, and which each use occupies until it is done, so the box is
  not stopped for being idle under it (docs/fleet-core/tau/index.md): a
  file call while it runs, `which` while it runs, a process until it exits,
  and a terminal until it ends. Its helper serves every call
  (docs/fleet-box-runtime/helper/index.md).
- **Files.** A call that names a path, `resolve` and `lstat`, goes to the
  box its path or its `cwd` names, written `fleet-box://<session><path>`,
  or else to the box of the session it is for, if a tau's. The targets a box
  gives are keyed the same way, with the plain path in the box as their
  display and process paths, so a call that takes a target goes where its
  key says, whoever makes it. A box's text streams in one chunk. Its
  failures are `FsError`s: the helper's code, or `FS_IO_ERROR`.
- **One box per session.** A tau's session's own work may name only its own
  box; another's is `FS_PERMISSION_DENIED`, so a model in a box never
  reaches another box. Any other caller may read any box, as every
  sandbox mode reads anything, but a box's files are written for its own
  session alone, `FS_PERMISSION_DENIED` for another, so a session's model
  writes no box its sandbox does not know of.
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
  the watch's stop or signal ends it (`fs.unwatch`). So the sidebar
  refreshes live. A watch neither starts the box nor occupies it, since the
  file viewer holds one for as long as it shows a folder: if it did, an
  open browser tab would keep the box running; and if a watch failed as its
  box stopped, the viewer's feed, which reads the folder again before it
  watches again, would start the box each time it stopped. So while the
  box is stopped, the watch waits (`ctx.fleetTauRuns.whenStarted`), and
  once something else starts the box, it watches there again and reports a
  change, since the files may have changed meanwhile. A failure while the
  box runs, or the session's deletion, is the watch's error.
- **Processes.** A tau's session's process runs in its box, in a process
  group of its own, in the folder dsh names, the session's project, a host
  folder, put in `/tau/workspace` in the box (`ctx.fleetTauRuns.boxPath`,
  docs/fleet-core/tau/index.md), as is a terminal's, and a file call's path
  or `cwd` in the project. It serves what dsh's bash asks: stdin
  ignored or given as data, and stdout and stderr collected into dsh's own
  in-memory tails (`OutputCollector`) as the helper sends them. Its
  environment, and a terminal's, is what dsh gives it, but dsh's own
  variables, `DSH_*`, which tell of the host, such as the dsh home and the
  web UI's URL, and are false in a box. Terminating
  it, or aborting its signal, ends its group, and so does this service's
  unloading. `resolveExecutable` asks the box's helper (`which`).
- **Terminals** (`terminal.ts`). dsh's terminal controller reaches
  `ctx.subprocess` through the session's agent, so a tau's session's
  sidebar terminal opens in its box: the helper runs the shell, the image's
  bash, on a pseudo-terminal there, and relays input, output and size. It
  reads the terminal's foreground process group from the kernel, which it
  signals, and ends the terminal's whole session, background jobs included,
  SIGHUP and SIGTERM, then SIGKILL after the grace period. Its activity is
  the helper's `terminal.activity`: `idle` when no process of its session
  is left, or the shell is the only one, in the foreground and asleep, as
  at its prompt; `busy` otherwise, a background job included; `unknown`
  while it ends, or when the helper cannot tell. So dsh's terminal
  controller reclaims a terminal no window has held for
  `unattendedTimeoutMs`, two hours by default, while it was idle, which
  ends its hold on the box, and the box stops once nothing else uses it;
  one still running a command keeps the box running.
- **Spill files.** dsh saves a tool result too big for the conversation
  to a spill file its model is told to read. A tau's session's would sit
  on the host, where its model does not look, so `fleet-spill` refuses
  them, and dsh keeps the result inline, as it does when a store fails,
  with a warning in its log. Every other session's are dsh's local
  store's.

## Not yet

- **No spill files** for a tau's session: bash says a box process's full
  output is unavailable, and big tool results stay inline.
- **Not served for a box:** raw pipes and the control channel.
- **Idle is a guess:** a loop of the shell's builtins that sleeps looks
  like a shell at its prompt; only prompt markers from the shell would
  tell for sure.
- **A terminal is no session activity:** archiving a tau's session does not
  wait for its open terminals; removing its box, once its run ended, ends
  them.
- **dsh's other host features** stay on the host: `@` file mentions and the
  changed-files card read the host's folder of a tau's session.

## Built on

- `@deepseek-ai/dsh-fs` and `@deepseek-ai/dsh-subprocess`, whose
  `FileSystem` and `SubprocessRuntime` the services extend.
- `@deepseek-ai/dsh-fs-sandbox`, `@deepseek-ai/dsh-subprocess-local` and
  `@deepseek-ai/dsh-spill-local`, for the host's side, and
  `OutputCollector` of the second; `@deepseek-ai/dsh-sandbox-policy`, for
  the sandbox mode; `@deepseek-ai/dsh-spill`, whose `SpillStore` the
  spill service extends.
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

With fleet-core in the `web` profile's bundles, `pnpm exec dsh web` mounts
the services. After `tau start --adaptor fleet`
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
