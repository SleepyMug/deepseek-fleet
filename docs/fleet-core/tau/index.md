# fleet-core/tau

The tau service. It starts runs of taus, each a box and a dsh session, and
watches each until its agent is done, then gives back how it ended, with
what it left at its `$out` and `$inout` handles put at the caller's paths,
and cancels and deletes runs. It runs in dsh's process, in the fleet profile.
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
| `start { tauDir, callerCwd, values }` | Start a run of the tau with the values: set up its box, start it, make the dsh session and give it its prompt. Answers `{ sessionId, box, prompt }`. |
| `list {}` | Every run, oldest first, as `status` gives each. |
| `status { sessionId }` | Where the run is, `running`, `ended` or `finished`, and once it ended, when and how: `{ ok, text, failure? }`; and the run that started it, its `parent`, if one did. |
| `finish { sessionId }` | Wait until the run ends, and answer how it did, the same each time. The first time, a run that succeeded puts what it gave back at the caller's paths. |
| `cancel { sessionId }` | Cancel the run's turn, which ends the run; a run that ended is let be. |
| `delete { sessionId }` | Archive the session, remove its box, running or not, and forget the run, and every run it started. |

Each of the service's operations takes who calls it, a run's caller:
`fleet`, on the host, through the socket, which reaches every run; or a
tau's session, from its box, whose paths are in its box, and which reaches
only the runs it started: any other is as if it were not there. Nothing
calls the service from a box yet; the `tau` API's extension will.

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
  1. It reads the tau where its caller has it (`callers.ts`, below), and
     binds the values with tau's library:
     `loadTau(tauDir).bind(values, { cwd: callerCwd }, place, '/tau/self')`
     checks the values against `tau.json`, places each handle, and expands
     `PROMPT.md` with the places. `checkInputs` then checks the caller's
     paths. Then `apis.ts` links the tau's APIs: `loadApis`, the extension
     that implements each one, from `ctx.fleetExts`, and
     `checkImplementation` against its client; then `loadExposed`. Nothing
     is made before these pass, so a tau with an API that no extension
     implements, or whose client does not fit it, is refused.
  2. It mints `session-<uuid>`, the form dsh's session ids take, which the
     dsh session gets.
  3. It creates the box `fleet-tau-<uuid>`, starts it, makes its folders
     with the helper's `exec` (`mkdir -p`), copies in the tau, each `$in`
     and `$inout` handle, and each API's client, has the helper link the
     APIs and what the tau exposes (`apis.link`), and stops it.
  4. It writes the registry entry.

  A failure in 3 or 4 removes the box.
- **Places** (`place.ts`), each under the base name of the caller's path:

  | What | Where in the box |
  |---|---|
  | an `$in` handle | `/tau/in/<base name>` |
  | an `$inout` handle | `/tau/workspace/<base name>` |
  | an `$out` handle | `/tau/out/<base name>` |
  | the tau's own directory, `${self}` | `/tau/self` |
  | the APIs, `@api/<name>`, and the packages the tau exposes | `/tau/node_modules` |
  | the client of each API's extension | `/tau/node_modules/.fleet/<name>` |

  A base name already taken in its folder gets a suffix in its stem:
  `notes.md`, `notes-1.md`, `notes-2.md`. An `$out` handle is not copied
  in. Its folder is made for a `dir`, and only its parent for a `file` or a
  `path`, since the agent makes what it leaves.

  Node looks for a package in every folder above the file that imports it,
  so a program anywhere below `/tau`, and the tau's own packages, find
  `/tau/node_modules`, and TypeScript does too. Each `@api/<name>` there is
  typed by the tau's own declarations, in `/tau/self/api/<name>`, and
  re-exports the client, so every import in a process gets one module.
- **Callers** (`callers.ts`). `fleet`'s paths are the host's, which the
  runs read and write as they are. A tau's session's are in its box, which
  its model controls, so nothing it names is read on the host where it is:
  - the tau's directory, and each `$in` and `$inout` handle, are copied out
    of its box, whole, with `docker cp`, to the run's folder on the host,
    and checked there with tau's `checkInputs`, as the host's paths are; the
    tau's directory as an `$in` folder is, so that its symlinks lead only
    inside it, and reading it reads nothing else of the host's. Problems
    name the paths as the caller does. The copies are copied into the run's
    box, then removed.
  - each `$out` handle's folder is checked in the caller's box, with a
    program the helper runs there, as `checkInputs` checks it on the host.
  - the run is in the calling session's project, as its dsh workspace.
  - what the run gives back is put in the caller's box: each path resolved
    there with `realpath`, a folder merged into a folder there entry by
    entry, and anything else put whole with `docker cp`, in place of what
    was there.

  Each of these is one of the calling session's operations on its box, in
  turn with its others; the box is started for those that run a program.
- **The registry** (`registry.ts`) has one JSON file per session,
  `$DSH_HOME/fleet/taus/<session id>.json`: who started the run, its
  caller; the box, the tau, the project,
  the expanded prompt and the request id it is sent under, each handle (its
  mode, kind, caller's path and place), the names of the APIs the tau
  declares, each linked, what it exposes, with what each says it is, when
  it was made, when it was given its prompt, when and how its run ended,
  and when a `finish` first gave that back. Beside it, a folder of the
  session's own, `$DSH_HOME/fleet/taus/<session id>/`, holds what the run
  gave back until a finish puts it at the caller's paths. An entry is
  written last, so an entry means a box that is set up, and before the dsh
  session is made. A service started later finds its sessions there. Only
  ids of the form the service mints name an entry, since they are file
  names.
- **Starting the run**, once its box is set up: `start` starts the box,
  then, through dsh's workspace registry and session controller:
  1. makes the project a dsh workspace, or finds the one it is;
  2. makes the session with the entry's id, in that workspace, with the
     `tau` preset, and titles it with the name of the tau's directory;
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
  why: what it did not leave, naming each place in the box; cancelled; the host stopped
  during the run, as dsh disposes of the agent then (`aborted` by
  `disposed`), or closes the cut turn later (`interrupted`); the model's
  error; and so on. The service records that in the entry, and stops the
  box, which keeps what is in it. What a person does in the session later,
  in the web UI, is the session's, not the run's.
- **Watching.** A run is watched from its start; when the service loads, it
  watches every run whose entry has not ended, so a run cut short by a
  restart ends there, with dsh's `interrupted`, and one whose start was cut
  short before its prompt ends as a failure that says so. The service takes
  its socket before it loads, so one that does not get it, as when another
  serves the same dsh home, records nothing.
- **What a run gives back** (`outputs.ts`), once its last turn completed:
  what its agent left at the place of each `$out` and `$inout` handle is
  copied out of the box whole, with `docker cp`, which keeps modes and
  symlinks, into the session's folder, one entry per handle, and checked
  there with tau's `checkOutputs`, as tau's docs/spec/paths.md asks: a file
  or a folder as declared, not a symlink itself, and each symlink in a
  folder relative and leading inside it. A run that does not pass fails. A
  run that failed has nothing copied out, and gives nothing back.
- **Finishing** waits for the run's end, which a client that goes away
  gives up, leaving the run as it is. The first time, for a run that
  succeeded, it puts what the run gave back at the caller's paths, as tau's
  docs/spec/results.md has it: a folder merges into a folder already
  there, each of its entries put the same way, and anything else replaces
  what is there. The caller's own path leads where its symlinks do; a
  symlink inside a folder there is replaced, not followed. Paths that lie in
  one another are put outer first, so the inner one wins. Then it records
  the finish in the entry, drops the session's folder, and answers how the
  run ended. It answers the same again, so a
  client that lost its connection, as when dsh restarts, asks again.
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
  box, where its `$inout` handles are. dsh runs a session's work in its
  workspace's folder, the project, a host path the box does not have; the
  runs' `boxPath` puts that folder, and any path in it, in
  `/tau/workspace` instead, for every process, terminal and file call the
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
  one line of JSON in, one out. A socket a service answers on is not taken
  over; one left by a service that died is.
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

- What a run gives back is copied whole, however large, once to the
  session's folder and once to the caller's paths; and an `$inout` handle
  merges into the caller's folder, so what the agent removed there stays.
- No box calls the service yet: the `tau` API's extension, which will, is
  to come.
- A box left by a dsh that died while it set up a run stays. `fleet-box list` shows
  it as `fleet-tau-…`, and `fleet-box delete` removes it.

## Built on

- `@sleepymug/tau`: `loadTau`, `bind`, `checkInputs`, `checkOutputs`,
  `loadApis`, `checkImplementation`, `loadExposed`.
- `ctx.fleetExts` (fleet-core/ext).
- `Box` and `exec` (`fleet-core/box`), and `copyOutWhole` and
  `copyInWhole` for what a run takes from a box and gives back.
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
