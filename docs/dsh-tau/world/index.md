# dsh-tau/world

The world of a host dsh-tau is installed in. A tau's session works on
the files of its box and runs its processes there, and the web UI's
sidebar shows that box: its file tree, previews and live refresh, and its
terminal. Every other session, such as one the web UI starts, works on the
host, through dsh's own implementations, its sandbox included, as if
dsh-tau were not there.

## Provides

Five dsh services. Three are what dsh's web UI and host plane reach for a
session, whatever its agent preset, which dsh-tau's `cordis.patch.yml`
mounts in place of dsh-base's rows: it disables `fs-sandbox`, `subprocess`
and `spill-local`, and each service mounts the module of the row it
replaces for every call that is not a box's.

| Row | Module | Service |
|---|---|---|
| `fleet-fs` | `@sleepymug/dsh-tau/world/fs` | `ctx.fs`, a `FileSystem`, dsh's sandboxed one for the host |
| `fleet-subprocess` | `@sleepymug/dsh-tau/world/subprocess` | `ctx.subprocess`, a `SubprocessRuntime`, dsh's local one for the host |
| `fleet-spill` | `@sleepymug/dsh-tau/world/spill` | `ctx.spillStore`, a `SpillStore`, dsh's local one for the host |

Two are the `tau` agent preset's own (docs/dsh-tau/tau/index.md), in
its `box` group, which isolates `fs`, `subprocess` and `shell`, so only the
preset's tools reach them, with dsh's local bash over them as their
`shell`:

| Row | Module | Service |
|---|---|---|
| `box-fs` | `@sleepymug/dsh-tau/world/box-fs` | `ctx.fs` of the boxes, and of nothing else |
| `box-subprocess` | `@sleepymug/dsh-tau/world/box-subprocess` | `ctx.subprocess` of the boxes, and of nothing else |

`fleet-fs` and `fleet-subprocess` are these two, with the host's side
added.

## Design

- **Whose call it is** (`caller.ts`): the session of the agent whose turn
  makes the call (`ctx.agents.currentInitiator()`), or else of the agent
  whose scoped context the caller reached the service through, as dsh's
  terminal controller reaches `ctx.subprocess` through `agent.ctx`. A call
  is a box's when that session is a tau's, which the runs of taus know at
  once (`ctx.fleetTauRuns.isTau`, docs/dsh-tau/tau/index.md).
- **The host's side** is dsh's own `SandboxedFileSystem`,
  `LocalSubprocessRuntime` and `LocalSpillStore`, the modules of the rows
  dsh-tau disables, which each service mounts in a context that
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
  not stopped for being idle under it (docs/dsh-tau/tau/index.md): a file
  call while it runs, `which` while it runs, a process until it exits, and
  a terminal until it ends. Each call is one of the box API's,
  `fleet.box.v1.Box`, which the gateway carries to the helper of the box,
  started, and which starts nothing (docs/fleet-sdk/index.md).
- **Files.** A call that names a path, `resolve` and `lstat`, goes to the
  box its path or its `cwd` names, written `fleet-box://<session><path>`,
  or else to the box of the session it is for, if a tau's; a relative path
  without a `cwd` is the agent's working directory's, `/tau/workspace`. The
  targets a box gives are keyed the same way, with the plain path in the
  box as their display and process paths, so a call that takes a target
  goes where its key says, whoever makes it. The box's files are served
  over its API as dsh's local file system has files on the host
  (`box-files.ts`): `resolve` is `Box.Resolve`, a target's key where its
  path leads, every symlink followed, or, for a path to nothing, its
  nearest folder that is there, and its display path the path as named;
  `stat` and `lstat` are `Box.Stat`, following the last symlink or not,
  and a version is the box's, `FileInfo.version`, which changes whenever
  the file does; `readText` is the file whole, UTF-8, a NUL in its first
  8 KiB making it binary, `FS_NOT_TEXT`, and its text streams in one chunk;
  `readBytes` and `readByteRange` are `Box.ReadFile`, and `listDir`
  `Box.ListDir`. Its failures are `FsError`s, by the call's code:
  `not_found` is `FS_NOT_FOUND`, `permission_denied`
  `FS_PERMISSION_DENIED`, `aborted` `FS_STALE_VERSION`, `canceled`
  `FS_ABORTED`, and any other `FS_IO_ERROR`.
- **Writes and edits.** `writeText` is `Box.WriteFile`, which replaces the
  file whole, through its symlinks, keeping its permission bits, its
  folders made if missing. Its guard is checked by the box as it puts the
  file in place, so a file changed since it was read is not overwritten:
  `createIfAbsent` writes exclusively, a file there `FS_NOT_OBSERVED`;
  `replaceIfVersion` writes only if the file is still at the version,
  else `FS_STALE_VERSION`. `editText` reads the file, replaces literal
  text, keeping its line endings, CRLF or LF, and writes it guarded by the
  version it read.
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
  `/tau/attachments` in its box, such as
  `/tau/attachments/v1/files/49/<sha256>/notes.csv`; the store's files
  never change, so a copy stays the same file. The answer comes at once,
  and the runs copy the file in then, `Box.Put`, once per session,
  readable by all and writable by none (`copyInOnce`,
  docs/dsh-tau/tau/index.md). The
  copy is one of the session's operations on its box, so the box's next
  use, which every file call, process and terminal waits for, comes after
  it; and the model acts on the answer only after the request it is in.
  Any other host file is not in a tau's session's world. Every other
  session gets dsh's own answer, the host path. The service's config names
  the dsh home, as `dshHomePath()` in the patch.
- **Watching** a box's target is one `Box.Watch` call, of the started box,
  which says first that the watch is ready, then each time what is at the
  path, or what the folder holds, may have changed, until the watch's stop
  or signal cancels it. So the sidebar
  refreshes live. A watch neither starts the box nor occupies it, since the
  file viewer holds one for as long as it shows a folder: if it did, an
  open browser tab would keep the box running; and if a watch failed as its
  box stopped, the viewer's feed, which reads the folder again before it
  watches again, would start the box each time it stopped. So while the
  box is stopped, the watch waits (`ctx.fleetTauRuns.whenStarted`, which
  follows the box's state as the gateway tells it), and once something
  else starts the box, it watches there again and reports a change, since
  the files may have changed meanwhile. A failure while the box runs, or
  the session's deletion, is the watch's error.
- **Processes.** A tau's session's process runs in its box, in a process
  group of its own, in the folder dsh names, the session's project, a host
  folder, put in `/tau/workspace` in the box (`ctx.fleetTauRuns.boxPath`,
  docs/dsh-tau/tau/index.md), as is a terminal's, and a file call's path
  or `cwd` in the project. It is one `Box.Spawn` call, for as long as it
  runs, and serves what dsh's bash asks: stdin ignored or given as data,
  then closed, and stdout and stderr collected into dsh's own in-memory
  tails (`OutputCollector`) as the box sends them. Its
  environment, and a terminal's, is the box's, with its run's context and
  its services', and what dsh gives it, but dsh's own variables, `DSH_*`,
  which tell of the host, such as the dsh home and the web UI's URL, and
  the host's `PATH` and `HOME`, which are false in a box, so the box's own
  stand: its PATH has the services' commands first, then the image's; the
  call gives what dsh adds as its environment, and what dsh unsets as its
  `unset_env`. Terminating it, or aborting its signal, sends its group
  SIGTERM, and, after its grace period, cancels the call, which has the box
  end the group; so does this service's unloading. `resolveExecutable` is
  `Box.Which`, whose empty answer, for a program not there, is dsh's
  `SubprocessExecutableNotFoundError`.
- **Terminals** (`terminal.ts`). dsh's terminal controller reaches
  `ctx.subprocess` through the session's agent, so a tau's session's
  sidebar terminal opens in its box, one `Box.Terminal` call for as long as
  it runs: the box runs the shell, the image's bash, on a pseudo-terminal
  there; input, a resize and a signal are requests of the call, and the
  output comes back on it. The terminal's foreground process group, which
  a signal goes to, and its activity, are the box's status, a request
  answered in order. Ending the terminal ends the call, which ends every
  process of its session, background jobs included. Its activity is
  `idle` when the box finds no process of its session left, or the shell
  the only one, in the foreground and asleep, as at its prompt; `busy`
  otherwise, a background job included; `unknown` while it ends, or when
  the box cannot tell. So dsh's terminal
  controller reclaims a terminal no window has held for
  `unattendedTimeoutMs`, two hours by default, while it was idle, which
  ends its hold of the box, and the box stops once nothing else occupies
  it; one still running a command keeps the box running.
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
- `ctx.fleetTauRuns` (dsh-tau/tau), and the boxes of fleet's gateway
  through it, with their API, `fleet.box.v1.Box`, of
  `@sleepymug/fleet-protocol/box`, over `@connectrpc/connect` and
  `@bufbuild/protobuf`.
- dsh's attachment store's layout, `$DSH_HOME/attachments/`, whose files
  `@deepseek-ai/dsh-attachment-local` names.

These are runtime imports, so they must be the copies the running dsh
loaded: run the workspace's dsh, `pnpm exec dsh`.

## How it runs

With dsh-tau in the `web` profile's bundles, and `fleet serve` running,
`pnpm exec dsh web` mounts the services. After `tau start --adaptor rpc`
(tau's docs/spec/client.md), the session's bash and file tools work in its
box:

```
$ docker exec box-5f1e… cat /tau/out/report.md   # written by the model's `write`
Added a line to index.md.
```

A file uploaded to the session in the web UI, and an image its model was
shown, are in its box where dsh tells the model they are:

```
$ docker exec box-5f1e… ls -l /tau/attachments/v1/files/49/492d…/
-r--r--r-- 1 node node 8 Oct  4 18:47 notes.csv
```
