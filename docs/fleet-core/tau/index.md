# fleet-core/tau

The tau service. It starts runs of taus, each a box and a dsh session, and
watches each until its agent is done, then gives back how it ended, with
what it left at its `out` and `inout` files, and cancels and deletes
runs. It runs in dsh's process, in the fleet profile. A run comes as a
**call** and goes back as a **result**, the archives of tau's
docs/spec/serialization.md: the caller packs the call from its files, and
puts the result at its paths, so the service never reads or writes a
caller's files, and serves a caller on the host and one in a box alike.
`start` sets up the run's box, mints the session's id and expands its prompt,
then makes the dsh session, in the caller's folder as its workspace, so the
web UI lists it there, and gives it the prompt, once the tau's init, if it
has one, asks for the agent. The session's bash and file
tools work in its box, through
fleet-core's world (docs/fleet-core/world/index.md). Each API the tau
declares is linked to the client of the extension that implements it
(docs/fleet-core/ext/index.md), whose calls the runs answer.

## Provides

Two dsh plugins, which fleet-core's `cordis.patch.yml` mounts:

- `fleet-tau-runs` (`@sleepymug/fleet-core/tau/runs-plugin`): the runs of taus and
  their boxes (`runs.ts`), as `ctx.fleetTauRuns`. It builds on the
  extensions provided, `ctx.fleetExts`, and uses nothing of dsh's.
- `fleet-tau` (`@sleepymug/fleet-core/tau/plugin`): the tau service (`service.ts`). It
  builds on `ctx.fleetTauRuns`, dsh's session controller, its workspace
  registry and its agents, and serves `@sleepymug/fleet-protocol/tau` on
  `$DSH_HOME/fleet/tau.sock`, for `fleet` (fleet-client):

| Op | What it does |
|---|---|
| `start { title, project, targets }`, then the call | Start a run of the call, which carries the tau: set up its box, start it, make the dsh session, titled `title`, in the dsh workspace of `project`, and give it its prompt, or, for a tau with an init, leave that to the run's watch; `targets`, where the caller has each `out` and `inout` file, by its name, are kept for `finish`. Answers `{ sessionId, box, prompt }`. |
| `list {}` | Every run, oldest first, as `status` gives each. |
| `status { sessionId }` | Where the run is, `running`, `ended` or `finished`, and once it ended, when and how: `{ ok, text, failure? }`; and the run that started it, its `parent`, if one did. |
| `finish { sessionId, history? }` | Wait until the run ends, and answer how it did and the targets, `{ result, targets }`, then send its result, the same each time; the caller puts what it gave back at the targets. With `history: true`, the answer holds the session's history too, `history`. |
| `cancel { sessionId }` | Cancel the run's init, or its turn, which ends the run; a run that ended is let be. |
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
persona, the tau's prompt plugin (`@sleepymug/fleet-core/tau/prompt`), the box's
reset notice (`@sleepymug/fleet-core/tau/reset`), bash in the foreground only, read/write/edit, the tau's skills,
and compaction. What its rows register
reaches only the sessions of that preset: dsh mounts them once, in the
preset's scope, which each of its sessions' agents has as its parent.

`ctx.fleetTauRuns` gives fleet-core's world
(docs/fleet-core/world/index.md) what it needs:

- `isTau(sessionId)`, at once, whether a session is a tau's;
- `boxPath(sessionId, path)`, at once, where a path of a tau's session's
  work is in its box: its project, and what is in it, in `/tau/workspace`;
- `boxFor(sessionId)`, the started box of a tau's session, started if it is
  not, and set up again from the run's call if it is gone; it fails while
  the session is archived;
- `hold(sessionId, occupant)`, the same, occupied by `occupant`, a turn, a
  terminal, a process, a call or a file call, until its release, so the
  box is not stopped for being idle while it is in use; `occupy` occupies
  without asking for the box, as a running agent does;
- `whenStarted(sessionId, signal)`, the box once something starts it,
  which starts nothing, for a watch;
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
     being refused. `loadTau(tau).check(json)` checks the call against
     `tau.json`: each file's mode and kind, each extra file's name, and the
     args against the schema, and gives the files the registry keeps; where
     the box places each file is the box's. Then `apis.ts`
     links the tau's APIs, as `loadTau` read them, each a copy of a
     contract, to the extension of its contract, from `ctx.fleetExts`,
     whose version serves the copy's, as tau's `serves` has it. A tau with
     an API whose contract no extension implements, or at no version that
     serves the copy's, is refused. Problems name the tau by the run's
     title. Here `session-<uuid>` is minted, the form dsh's
     session ids take, which the dsh session gets.
  2. It creates the box `fleet-tau-<uuid>`, starts it, and has the box's
     runtime set it up from the call (fleet-box-runtime's tau runtime, below),
     which reports the prompt and where things are; copies
     each API's client in, where the runtime says; has the helper link the
     APIs and what the tau exposes (`apis.link`); and stops it.
  3. It writes the registry entry, with the files it checked and what the
     runtime reported, and
     removes the tau it read; the call stays until the run is deleted.

  A failure removes the box and the session's folder. A tau's session's
  run is in the session's own project; `fleet`'s in the folder it names,
  through its symlinks.
- **The box's runtime** (fleet-box-runtime/tau): the runtime's side of tau's
  library, in the image, which owns where a run has its things in its box.
  The host runs it in a run's box with `docker exec` (`Box.pipe`), since
  the helper's lines of JSON would carry the archives only as text:
  - `setup` reads the call on its stdin, places the tau, checks the call
    again (`check`), gives each file its place (./layout.ts), places the
    content of the `in` and `inout` files there, expands the args, the
    prompt, and the tau's init, if it has one, with the places (`expand`),
    makes each `out` folder, keeps the files, their places and the args the
    agent sees in `/tau/.run.json`, puts tau's `TAU.md`, as its tau library
    has it, at `/tau/TAU.md`, and reports `{ prompt, cwd, modules, self,
    clients, init? }`: the prompt, the agent's working directory, where the
    APIs and the clients go, where the tau is, and the init. It runs before the agent, on a
    call the host checked, and runs no code of the tau's, so the host takes
    its report as its own.
  - `pack` writes the result on its stdout, from what the agent left at
    each `out` and `inout` file's place, checked with `checkOutputs`, or
    a failure that says why it does not fit. The result is checked on the
    host after it leaves the box, since the box is the agent's by then.
- **Places**, as the box's runtime has them (fleet-box-runtime/tau/layout),
  each under the base name of the caller's path, or, for an `in` given a
  list of paths, the file's name:

  | What | Where in the box |
  |---|---|
  | an `in` file | `/tau/in/<base name>` |
  | an `inout` file | `/tau/workspace/<base name>` |
  | an `out` file | `/tau/out/<base name>` |
  | the tau's own directory, `${self}` | `/tau/self` |
  | the APIs, `@api/<alias>`, and the packages the tau exposes | `/tau/node_modules` |
  | the client of each API's extension | `/tau/node_modules/.fleet/<alias>` |
  | tau's `TAU.md`, what a tau is, for the agent to read | `/tau/TAU.md` |

  A base name already taken in its folder gets a suffix in its stem:
  `notes.md`, `notes-1.md`, `notes-2.md`. An `out` file has no content
  in a call. Its folder is made for a `dir`, and only its parent for a
  `file` or one that may be either, since the agent makes what it leaves.

  Node looks for a package in every folder above the file that imports it,
  so code anywhere below `/tau`, the tau's own packages included, finds
  `/tau/node_modules`, and TypeScript does too. The agent runs its programs
  from the tau's own directory, `cd /tau/self; node -`, Node reading the
  program from stdin and resolving its imports from its working directory,
  so a program resolves as the tau's code does: the tau's `node_modules`
  first, every package of its own whether exposed or not, then
  `/tau/node_modules`. Each `@api/<alias>` there is
  typed by the tau's copy of its contract, in `/tau/self/api/<alias>`, and
  re-exports the client, so every import in a process gets one module.
- **The registry** (`registry.ts`) has one JSON file per session,
  `$DSH_HOME/fleet/taus/<session id>.json`: who started the run, its
  caller; the box, the run's title, the project,
  the expanded prompt and the request id it is sent under, the tau's init,
  its expanded command and where it runs in the box, if it has one, each file (its
  name, mode, kind, base name and place), the targets, the working directory and
  the APIs' folder in the box, as the runtime reported them, the contracts of the
  APIs the tau holds, each linked, what it exposes, with what each says it is,
  when it was made, when it was given its prompt, when and how its run
  ended, when a `finish` first gave that back, and when the box was last
  set up again, if it was. Beside it, a folder of
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

  For a tau with an init, the start stops after step 2, and the run's
  watch runs the init first (below), then takes steps 3 and 4 unless the
  init did the run.

  A failure on the way archives the session and removes the box and the
  entry, so a run either started or left nothing. A session's operations
  run one after another, so its start, its end, a finish and a deletion
  keep their order.
- **The init** of a tau that has one (`init.ts`, tau's docs/spec/init.md)
  runs as its run's watch begins: the helper spawns `sh -c` with the
  command, `${self}` expanded as `/tau/self` by the box's `setup`, in the
  agent's working directory, `/tau/workspace`, as `spawn` does a bash
  command of the agent's, with `$FLEET_SOCKET`, so a program of the tau's,
  such as `node ${self}/init.mts`, imports what the agent's programs do,
  and its API calls are the session's, nested runs included; it occupies the box until it exits. Its exit says what comes
  next: 0, `TAU_SKIP`, ends the run without the agent, which the session
  never gets a prompt for, init's stdout its text, and the run succeeds as
  if the agent had, packing what init left (below); 100, `TAU_RUN`, gives
  the session its prompt as it is; 101, `TAU_FALLBACK`, and any other
  exit, or a signal, gives it the prompt followed by a note that init
  failed, how it ended, and what it wrote to stdout and stderr, each in a
  fenced block. An init that cannot run at all fails the run. Cancelling
  the run kills the init's process group and ends the run as cancelled;
  a host that stops meanwhile kills it too, and the run then ends as one
  whose start was cut short before its prompt.
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
  run's files, `checkResult`: an output for each `out` and `inout`
  file, of its kind, and the agent's own text. One that
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
- **A run's history**, for a caller to inspect it, is its session's events,
  oldest first, as dsh's session controller inspects them: the prompt, each
  request's system prompt and tools, each model message, tool call and
  result, and each turn's end. A `finish` that asks gives it back in its
  answer, read when it answers, failed run or not. It is dsh's, not
  tau's spec's, so its form is dsh's session log's, and the caller
  writes it where it wants it, as with the result.
- **Cancelling** cancels the session's turn, or its init, while that
  runs; the run then ends as cancelled, which its watch records.
- **The runs a run started** go with it. Once a run ends, its box is
  stopped, and nothing it started and did not finish can give anything
  back, so those runs are deleted. Deleting a run deletes every run it
  started first, finished or not, and theirs.
- **Deleting** archives the session, stopping its work, since dsh does not
  delete sessions; then it removes the box and the session's folder, and
  forgets the session. A
  session never started is not dsh's, so there is nothing to archive. An
  archive that fails keeps the box and the entry.
- **An idle box stops.** A session's box runs while anything occupies it:
  its agent while it runs (`fleet-tau` follows `agent/status` and
  `agent/disposed`), and the world's file calls, processes and terminals,
  each through `hold` from before it asks for the box until nothing of it
  can reach the box. When the last leaves, the box is stopped after
  `idleStopMs`, 60 s by default, in `fleet-tau-runs`' config, unless
  something occupies it again meanwhile; its next use starts it again. A
  run's end stops its box at once, as its result is packed, unless
  something occupies it, such as a user's terminal, and then as soon as
  nothing does. `boxFor` occupies for no longer than it asks, so a box it
  starts for no one stops once it is idle. A box is not started here
  again from the moment its stop begins, so a watch it ends knows it
  stopped, and waits for its next start.
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
  model works, its box, that its working directory is `/tau/workspace`,
  and that `/tau/TAU.md` says what a tau is, and what a run of one
  promises; after it, for a tau that exposes something, a section,
  `fleet:tau-programs`, says to run programs with `node` from the tau's
  directory, `cd /tau/self; node - <<'EOF'`, and that they import, resolving
  from `/tau/self`, what it lists: each exposed API or package, with what it
  says it is, from the session's registry entry, whose declarations the
  model reads in its folder; and the assembly leaves out dsh's sections about the host,
  which are false in a box: the harness's checkout (`harness:source`), the
  web GUI at its URL (`app:web-surface`), the web UI's file cards and links
  (`ui:deliverable-file-references`), and `@` mentions as host paths
  (`context:file-reference`). It removes them by name from the assembled
  prompt (the `system-prompt/assemble` waterfall), since the last is
  registered in each agent's own scope, which a section of the preset's
  cannot shadow. It also leaves out the runtime context on the sandbox
  policy (`sandbox:policy`), the host's file policy, full access, which is
  not the box's. The web UI's own sessions keep dsh's whole prompt.
- **The tau's skills** are dsh's: the preset mounts dsh's file-system skill
  provider with one root, `/tau/self/skills`, each skill a folder in it
  with a `SKILL.md`, and none of dsh's project, user or bundled roots, and
  dsh's `skill` tool, which lists them to the model and loads one, with
  its folder in the box as the base of the paths it names. The provider
  reads through the world, so from the session's box, and watches nothing,
  since its root is no host path. Its catalog is kept per agent, so each
  session sees its own tau's.
- **The working directory** of a tau's session is `/tau/workspace` in its
  box, where its `inout` files are, as the runtime reported it. dsh runs
  a session's work in its workspace's folder, the project, a host path the
  box does not have; the runs' `boxPath` puts that folder, and any path in
  it, in the working directory instead, for every process, terminal and file call the
  world serves from the box.
- **Which sessions are a tau's.** The runs read the registry's entries when
  the plugin loads, each session's project with its id, and keep them as
  sessions are created and deleted, so that
  `isTau` answers at once, as a process's start, which cannot wait, needs.
- **Archiving removes the box.** The plugin follows which sessions dsh has
  archived, through the workspace registry's writes (`domain/changed`),
  since archiving has no event of its own, and tells the service, as it
  loads and on each change. A run whose session is archived, or whose
  caller is, or the caller's caller, and so on through the registry's
  callers, has its box removed once the run has ended, since the box packs
  the run's result as it ends: a stop-and-archive cancels the run's turn,
  and the run ends soon after. Its entry, call and result stay, so its
  caller can still `finish` it, and only deleting it forgets it. While the
  session is archived, `boxFor` fails, and so does the world's work in the
  box. A session that no longer is archived has no box until its next use.
- **A box gone is set up again** from the run's call, which the session's
  folder keeps, when `boxFor`, a start for a `pack`, or a copy next needs
  it: after an unarchive, or a box removed by other means. The tau is read
  from the call again, and its APIs linked to the extensions provided now,
  so one no longer provided fails the set-up, and the box is created under
  its name, set up by its runtime, given the clients and linked, as when
  the run started; the entry records the files, the working directory,
  the APIs and what the tau exposes as they are now, and when. The box is
  then as it was when the run began: what the agent did in it is gone.
- **The agent is told** (`reset.ts`, in the preset). Before each step of a
  tau's session that sends messages, the plugin has the box ready, through
  `boxFor`, so a failure to set it up fails the step rather than a tool
  call. When the box was set up again since the agent was last told, a
  notice goes before the step's messages, saying so: a user message with a
  source of its own, `fleet-tau-box`, which the session's log keeps, and
  which a projection of the log folds into the setup it told of.
- **A box gone** when the session is deleted still lets the session be
  forgotten.
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
  folder; and an `inout` file merges into the caller's folder, so what
  the agent removed there stays.
- The runs a session that is no tau's started with `tau_run`, and their
  sessions, stay, without their boxes, when the session is archived; `fleet
  delete` forgets them.
- A box left by a dsh that died while it set up a run stays. `fleet-box list` shows
  it as `fleet-tau-…`, and `fleet-box delete` removes it.

## Built on

- dsh's `domain/changed` (`@deepseek-ai/dsh-storage-domain`), for the
  archived sessions; `agent/pre-step`, `@deepseek-ai/dsh-llm`'s
  `createUserMessage` and `@deepseek-ai/dsh-session-projection`, for the
  notice.
- `@sleepymug/tau`: `loadTau`, with its `apis` and `exposed`, `check`, `expand`, and
  `serves`; and `@sleepymug/tau/call`: `readCall`, `placeCall`,
  `readResult`, `checkResult`, `writeResult`.
- `ctx.fleetExts` (fleet-core/ext).
- `Box` and `exec` (`@sleepymug/fleet-core/box`), with `Box.pipe` for the archives
  the box's runtime reads and writes, and fleet-box-runtime's tau runtime, in
  the image.
- `@sleepymug/fleet-protocol/tau`, for the wire.
- dsh's session controller, workspace registry and agents
  (`@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-workspace`,
  `@deepseek-ai/dsh-agent`), and `@deepseek-ai/dsh-agent-preset`, `dsh-tool-bash`, `dsh-tool-fs`,
  `dsh-skill-filesystem` and `dsh-tool-skill` for the `tau` preset.

## How it runs

The fleet profile lists fleet-core after dsh's base and web bundles, in
`$DSH_HOME/profiles/fleet/package.json`:

```json
{
  "dependencies": { "@sleepymug/fleet-core": "link:<checkout>/packages/fleet-core" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@sleepymug/fleet-core"] } }
}
```

`pnpm exec dsh plugin --profile fleet add link:<checkout>/packages/fleet-core`
makes it so; each extension is a bundle listed after fleet-core, added the
same way, such as `link:<checkout>/ext/fleet-ext-notes`. fleet-core's patch
is the profile's layer as well: no sandbox,
nothing that waits on a person, and one agent preset, `fleet`, for the web
UI's sessions, whose tools work on the host. docs/install.md installs it
all from npm instead.

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
