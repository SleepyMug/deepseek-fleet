# fleet-core/tau

The tau service. It starts runs of taus, each a box and a dsh session, and
watches each until its agent is done, then gives back how it ended, with
what it left at its `$out` and `$inout` handles, and cancels and deletes
runs. It runs in dsh's process, in the fleet profile. A run comes as a
**call** and goes back as a **result**, the archives of tau's
docs/spec/serialization.md: the caller packs the call from its files, and
puts the result at its paths, so the service never reads or writes a
caller's files, and serves a caller on the host and one in a box alike.
`start` sets up the run's box, mints the session's id and expands its prompt,
then makes the dsh session, in the caller's folder as its workspace, so the
web UI lists it there, and gives it the prompt. The session's bash and file
tools work in its box, through
fleet-core's world (docs/fleet-core/world/index.md). Each API the tau
declares is linked to the client of the extension that implements it
(docs/fleet-core/ext/index.md), whose calls the runs answer.

## Provides

Two dsh plugins, which fleet-core's `cordis.patch.yml` mounts:

- `fleet-tau-runs` (`fleet-core/tau/runs-plugin`): the runs of taus and
  their boxes (`runs.ts`), as `ctx.fleetTauRuns`. It builds on the
  extensions provided, `ctx.fleetExts`, and uses nothing of dsh's.
- `fleet-tau` (`fleet-core/tau/plugin`): the tau service (`service.ts`). It
  builds on `ctx.fleetTauRuns`, dsh's session controller, its workspace
  registry and its agents, and serves `fleet-protocol/tau` on
  `$DSH_HOME/fleet/tau.sock`, for `fleet` (fleet-client):

| Op | What it does |
|---|---|
| `start { title, project, targets }`, then the call | Start a run of the call, which carries the tau: set up its box, start it, make the dsh session, titled `title`, in the dsh workspace of `project`, and give it its prompt; `targets`, where the caller has each `$out` and `$inout` handle, are kept for `finish`. Answers `{ sessionId, box, prompt }`. |
| `list {}` | Every run, oldest first, as `status` gives each. |
| `status { sessionId }` | Where the run is, `running`, `ended` or `finished`, and once it ended, when and how: `{ ok, text, failure? }`; and the run that started it, its `parent`, if one did. |
| `finish { sessionId }` | Wait until the run ends, and answer how it did and the targets, `{ result, targets }`, then send its result, the same each time; the caller puts what it gave back at the targets. |
| `cancel { sessionId }` | Cancel the run's turn, which ends the run; a run that ended is let be. |
| `delete { sessionId }` | Archive the session, remove its box, running or not, and forget the run, and every run it started. |

Each of the service's operations takes who calls it, a run's caller:
`fleet`, on the host, through the socket, which reaches every run; or a
session, which reaches only the runs it started: any other is as if it were
not there. Who calls makes no difference to a run's files, which only the
caller reads and writes. The plugin provides the service as `ctx.fleetTau`
to the sessions' two ways in:

- a tau's session calls it from its box, through the `tau` API's extension
  (docs/fleet-ext-tau/index.md), and its runs are in its own project;
- another session, such as the web UI's, calls it with `tau_run`
  (docs/fleet-core/tools/index.md), and its runs are in its working
  directory, which it names as `fleet` names its folder.

The patch also declares `tau`, the agent preset a tau's session has: a
persona, the tau's prompt plugin (`fleet-core/tau/prompt`), bash in the
foreground only, read/write/edit, `ts_modules` and `ts_execute`
(docs/fleet-core/tools/index.md), and compaction. What its rows register
reaches only the sessions of that preset: dsh mounts them once, in the
preset's scope, which each of its sessions' agents has as its parent.

`ctx.fleetTauRuns` gives fleet-core's world
(docs/fleet-core/world/index.md) what it needs:

- `isTau(sessionId)`, at once, whether a session is a tau's;
- `boxPath(sessionId, path)`, at once, where a path of a tau's session's
  work is in its box: its project, and what is in it, in `/tau/workspace`;
- `boxFor(sessionId)`, the started box of a tau's session, started if it is
  not;
- `copyInOnce(sessionId, from, to)`, at once, a host file copied into the
  box of a tau's session before its next use, for dsh's attachments.

## Design

- **Setting up the box** (`runs.ts`), the first part of `start`, goes in
  this order:
  1. It checks the call as it comes, before it keeps anything or makes a
     box, writing it to the session's folder,
     `$DSH_HOME/fleet/taus/<session id>/call.tar`, as it reads it: tau's
     `readCall` checks it whole, as tau's docs/spec/serialization.md has
     it, and the tau it carries is extracted beside it, a call without one
     being refused. `loadTau(tau).bind(values, …)` checks the values against
     `tau.json`, and each handle's kind against its type; where the box
     places each handle is the box's. Then `apis.ts` links the tau's APIs:
     `loadApis`, the extension that implements each one, from
     `ctx.fleetExts`, and `checkImplementation` against its client; then
     `loadExposed`. A tau with an API that no extension implements, or whose
     client does not fit it, is refused. Problems name the tau by the run's
     title. Here `session-<uuid>` is minted, the form dsh's
     session ids take, which the dsh session gets.
  2. It creates the box `fleet-tau-<uuid>`, starts it, and has the box's
     runtime set it up from the call (fleet-box-runtime's tau runtime, below),
     which reports the prompt, the handles and where things are; copies
     each API's client in, where the runtime says; has the helper link the
     APIs and what the tau exposes (`apis.link`); and stops it.
  3. It writes the registry entry, with what the runtime reported, and
     removes the tau it read; the call stays until the run is deleted.

  A failure removes the box and the session's folder. A tau's session's
  run is in the session's own project; `fleet`'s in the folder it names,
  through its symlinks.
- **The box's runtime** (fleet-box-runtime/tau): the runtime's side of tau's
  library, in the image, which owns where a run has its things in its box.
  The host runs it in a run's box with `docker exec` (`Box.pipe`), since
  the helper's lines of JSON would carry the archives only as text:
  - `setup` reads the call on its stdin, checked again, places the tau and
    the content of the `$in` and `$inout` handles, binds the values, which
    expands the prompt, makes each `$out` folder, keeps the handles and the
    values the agent sees in `/tau/.run.json`, and reports
    `{ prompt, cwd, modules, self, clients, handles }`: the prompt, the
    agent's working directory, where the APIs and the clients go, where the
    tau is, and each handle with its place. It runs before the agent, on a
    call the host checked, and runs no code of the tau's, so the host takes
    its report as its own.
  - `pack` writes the result on its stdout, from what the agent left at
    each `$out` and `$inout` handle's place, checked with `checkOutputs`, or
    a failure that says why it does not fit. The result is checked on the
    host after it leaves the box, since the box is the agent's by then.
- **Places**, as the box's runtime has them (fleet-box-runtime/tau/layout),
  each under the base name of the caller's path:

  | What | Where in the box |
  |---|---|
  | an `$in` handle | `/tau/in/<base name>` |
  | an `$inout` handle | `/tau/workspace/<base name>` |
  | an `$out` handle | `/tau/out/<base name>` |
  | the tau's own directory, `${self}` | `/tau/self` |
  | the APIs, `@api/<name>`, and the packages the tau exposes | `/tau/node_modules` |
  | the client of each API's extension | `/tau/node_modules/.fleet/<name>` |

  A base name already taken in its folder gets a suffix in its stem:
  `notes.md`, `notes-1.md`, `notes-2.md`. An `$out` handle has no content
  in a call. Its folder is made for a `dir`, and only its parent for a
  `file` or a `path`, since the agent makes what it leaves.

  Node looks for a package in every folder above the file that imports it,
  so a program anywhere below `/tau`, and the tau's own packages, find
  `/tau/node_modules`, and TypeScript does too. Each `@api/<name>` there is
  typed by the tau's own declarations, in `/tau/self/api/<name>`, and
  re-exports the client, so every import in a process gets one module.
- **The registry** (`registry.ts`) has one JSON file per session,
  `$DSH_HOME/fleet/taus/<session id>.json`: who started the run, its
  caller; the box, the run's title, the project,
  the expanded prompt and the request id it is sent under, each handle (its
  mode, kind, name, blob and place), the targets, the working directory and
  the APIs' folder in the box, as the runtime reported them, the names of the APIs the
  tau declares, each linked, what it exposes, with what each says it is,
  when it was made, when it was given its prompt, when and how its run
  ended, and when a `finish` first gave that back. Beside it, a folder of
  the session's own, `$DSH_HOME/fleet/taus/<session id>/`, holds the call,
  `call.tar`, and the run's result, `result.tar`, until the session is
  deleted. An entry is
  written last, so an entry means a box that is set up, and before the dsh
  session is made. A service started later finds its sessions there. Only
  ids of the form the service mints name an entry, since they are file
  names.
- **Starting the run**, once its box is set up: `start` starts the box,
  then, through dsh's workspace registry and session controller:
  1. makes the project a dsh workspace, or finds the one it is;
  2. makes the session with the entry's id, in that workspace, with the
     `tau` preset, and titles it with the run's title;
  3. queues the prompt under the entry's request id;
  4. records in the entry when the session got its prompt.

  A failure on the way archives the session and removes the box and the
  entry, so a run either started or left nothing. A session's operations
  run one after another, so its start, its end, a finish and a deletion
  keep their order.
- **A run ends** at the first time its agent is done with its prompt: the
  service waits for the agent's `whenIdle()`, then reads the session's log
  with the session controller's `inspect` (`outcome.ts`). The run succeeded
  if its last turn completed, and left what its tau declares (below); its
  text is the last its agent wrote. Any other end is a failure, which says
  why: what it did not leave, naming each place in the box; a result its
  box gave that does not fit the run; cancelled; the host stopped
  during the run, as dsh disposes of the agent then (`aborted` by
  `disposed`), or closes the cut turn later (`interrupted`); the model's
  error; and so on. The service keeps the run's result, records how it
  ended in the entry, and stops the box, which keeps what is in it. What a person does in the session later,
  in the web UI, is the session's, not the run's.
- **Watching.** A run is watched from its start; when the service loads, it
  watches every run whose entry has not ended, so a run cut short by a
  restart ends there, with dsh's `interrupted`, and one whose start was cut
  short before its prompt ends as a failure that says so. The service takes
  its socket before it loads, so one that does not get it, as when another
  serves the same dsh home, records nothing.
- **What a run gives back**, once its last turn completed, its box packs
  (`pack`, above) into the session's folder, and the service reads it
  again, as tau's library does, `readResult`, and checks it against the
  run's handles, `checkResult`: an output for each `$out` and `$inout`
  handle, of its mode, name and kind, and the agent's own text. One that
  does not fit fails the run. A run that failed gives nothing back: its
  result, which the host writes, holds how it ended alone.
- **Finishing** waits for the run's end, which a client that goes away
  gives up, leaving the run as it is. Then it answers how the run ended and
  the targets, and sends the result; the first time, it records the finish
  in the entry. The caller puts what the result holds at the targets, with
  tau's `applyResult`, as tau's docs/spec/results.md has it, trusting the
  service as to what goes where. The service answers the same again, so a
  client that lost its connection, as when dsh restarts, asks again, and a
  client other than the one that started the run can finish it.
- **Cancelling** cancels the session's turn; the run then ends as
  cancelled, which its watch records.
- **The runs a run started** go with it. Once a run ends, its box is
  stopped, and nothing it started and did not finish can give anything
  back, so those runs are deleted. Deleting a run deletes every run it
  started first, finished or not, and theirs.
- **Deleting** archives the session, stopping its work, since dsh does not
  delete sessions; then it removes the box and the session's folder, and
  forgets the session. A
  session never started is not dsh's, so there is nothing to archive. An
  archive that fails keeps the box and the entry.
- **One `Box` per session.** The runs open each session's box once and keep
  it, so the box's verbs run in order. When `fleet-tau-runs` unloads, as
  dsh exits, it stops the boxes it started, `boxFor`'s included.
- **Copies on demand.** `copyInOnce` queues the copy as one of the
  session's operations, so a `boxFor` asked after it waits for it. It
  starts the box, makes the place's folder with the helper's `exec`
  (`mkdir -p`), copies the file with `docker cp` and makes it read-only
  (`chmod a=r`). A place is copied once per session; a copy that fails is
  printed, and copied again when asked again. The copies stay in the box,
  across a stop, until it is removed.
- **Calls.** Each start of a session's box gives its helper what answers
  the calls of the clients in it. A call must name an API the session's tau
  declares, as its registry entry has it, and a method of the server of
  the extension that implements it now. That method gets the call's
  arguments, the session's id, which is the box's whatever the call says,
  and a signal that aborts when the caller goes away. A box started to set
  up a run answers no calls.
- **The system prompt** of a tau's session is dsh's, shaped by
  `prompt.ts` in the preset: after the persona, a section says where the
  model works, its box, and that its working directory is
  `/tau/workspace`; and the assembly leaves out dsh's sections about the host,
  which are false in a box: the harness's checkout (`harness:source`), the
  web GUI at its URL (`app:web-surface`), the web UI's file cards and links
  (`ui:deliverable-file-references`), and `@` mentions as host paths
  (`context:file-reference`). It removes them by name from the assembled
  prompt (the `system-prompt/assemble` waterfall), since the last is
  registered in each agent's own scope, which a section of the preset's
  cannot shadow. It also leaves out the runtime context on the sandbox
  policy (`sandbox:policy`), the host's file policy, full access, which is
  not the box's. The web UI's own sessions keep dsh's whole prompt.
- **The working directory** of a tau's session is `/tau/workspace` in its
  box, where its `$inout` handles are, as the runtime reported it. dsh runs
  a session's work in its workspace's folder, the project, a host path the
  box does not have; the runs' `boxPath` puts that folder, and any path in
  it, in the working directory instead, for every process, terminal and file call the
  world serves from the box, and for `ts_execute`.
- **Which sessions are a tau's.** The runs read the registry's entries when
  the plugin loads, each session's project with its id, and keep them as
  sessions are created and deleted, so that
  `isTau` answers at once, as a process's start, which cannot wait, needs.
- **A box gone.** Deleting a session whose box was removed by other means
  still forgets the session.
- **The socket** (`server.ts`) has mode 0600, and its folder is made with
  mode 0700, so only the owner can open it. That is its authentication, as
  it is for the dsh home's own files. It takes one request per connection:
  one line of JSON in, with a `start`'s call after it, up to the end of
  what the client sends, and one out, with a `finish`'s result after it. A
  socket a service answers on is not taken over; one left by a service
  that died is.
- **Printing.** The service prints what it does, the expanded prompt
  included, on dsh's stderr, after `fleet-tau:`. dsh's logger shows no info.
- **dsh, through one interface.** The service reaches dsh's sessions only
  through `Sessions` (`service.ts`), which the plugin implements with
  `ctx.sessionController` and `ctx.workspaceRegistry`, as the web client's
  own calls go, so the web UI follows the session live. The plugin imports
  only their types; its config gives it the dsh home, as `dshHomePath()` in
  the patch.
- **Two plugins, in the order they need each other.** dsh's session
  controller needs `ctx.fs`, the world's, which needs the runs. So the runs
  are a plugin of their own, which needs only the extensions, and the tau
  service, which needs the session controller, comes last:

  ```
  fleet-exts  ←  fleet-tau-runs  ←  fleet-fs, fleet-subprocess  ←  session controller
                        ↑                                                  ↑
                        └──────────────────  fleet-tau  ───────────────────┘
  ```

## Not yet

- A call and a result are kept whole, however large, in the session's
  folder; and an `$inout` handle merges into the caller's folder, so what
  the agent removed there stays.
- The runs a session that is no tau's started with `tau_run` stay when the
  session is archived; `fleet delete` removes them.
- A box left by a dsh that died while it set up a run stays. `fleet-box list` shows
  it as `fleet-tau-…`, and `fleet-box delete` removes it.

## Built on

- `@sleepymug/tau`: `loadTau`, `bind`, `loadApis`, `checkImplementation`,
  `loadExposed`; and `@sleepymug/tau/call`: `readCall`, `placeCall`,
  `readResult`, `checkResult`, `writeResult`.
- `ctx.fleetExts` (fleet-core/ext).
- `Box` and `exec` (`fleet-core/box`), with `Box.pipe` for the archives
  the box's runtime reads and writes, and fleet-box-runtime's tau runtime, in
  the image.
- `fleet-protocol/tau`, for the wire.
- dsh's session controller, workspace registry and agents
  (`@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-workspace`,
  `@deepseek-ai/dsh-agent`), and `@deepseek-ai/dsh-agent-preset`, `dsh-tool-bash` and `dsh-tool-fs` for
  the `tau` preset.

## How it runs

The fleet profile lists fleet-core after dsh's base and web bundles, in
`$DSH_HOME/profiles/fleet/package.json`:

```json
{
  "dependencies": { "fleet-core": "link:<checkout>/packages/fleet-core" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "fleet-core"] } }
}
```

`pnpm exec dsh plugin --profile fleet add link:<checkout>/packages/fleet-core`
makes it so; each extension is a bundle listed after fleet-core, added the
same way, such as `link:<checkout>/ext/fleet-ext-notes`. fleet-core's patch
is the profile's layer as well: no sandbox,
nothing that waits on a person, and one agent preset, `fleet`, for the web
UI's sessions, whose tools work on the host.

After `pnpm build` and `pnpm image`, `pnpm exec dsh --profile fleet`, with
the dsh the workspace pins, starts the service with the web host, and
`fleet` talks to it
(docs/fleet-client/index.md). On dsh's stderr:

```
fleet-tau: created session-4a65… in box fleet-tau-4a65…, with the prompt:
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
fleet-tau: started session-4a65… in /home/me/notes, and gave it its prompt
fleet-tau: session-4a65… ended
fleet-tau: deleted session-4a65… and its box fleet-tau-4a65…
```
