# fleet-core/tau

The tau service, the backend of tau's fleet adaptor (tau's
docs/spec/fleet.md): tau's client, the `tau` command or its SDK, hands it
runs, and the service runs each as a box and a dsh session, watches it
until its agent is done, then gives back how it ended, with what it left
at its `out` and `inout` files, and releases runs. It runs in dsh's
process, in the profile fleet-core is installed in, such as dsh's `web`
(docs/install.md). It is built on tau's backend SDK (tau's
docs/spec/backend.md). A run comes as a **call** and goes back as a
**result**, the archives of tau's docs/spec/serialization.md: the caller's
adaptor packs the call from its files, and checks the result and puts it
at its paths, so the service never learns a caller's paths, and serves a
caller on the host and one in a box alike. A submit sets up the run's
box, mints the session's id and expands its prompt,
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
  extensions provided, `ctx.fleetExts`, and uses nothing of dsh's. The
  runs put together what a run needs: its admission (`admission.ts`), its
  box's setup by the box's runtime (`box-setup.ts`), the registry
  (`registry.ts`), each session's box (`session-box.ts`), and the calls of
  its clients (`calls.ts`).
- `fleet-tau` (`@sleepymug/fleet-core/tau/plugin`): the tau service (`service.ts`). It
  builds on `ctx.fleetTauRuns`, dsh's session controller, its workspace
  registry and its agents, and serves its requests (`wire.ts`) with tau's
  `listenFleet` on `$DSH_HOME/fleet/tau.sock`, for the host's `tau
  --adaptor fleet` and `fleet` (fleet-client): a run's, as tau's fleet
  adaptor makes them (tau's docs/spec/fleet.md), and the service's own,
  as `@sleepymug/fleet-protocol/tau` has them:

| Request | What it does |
|---|---|
| `submit { title, project? }`, then the call | Start a run of the call, which carries the tau: admit it, set up its box, start it, make the dsh session, titled `title`, in the dsh workspace of `project`, and give it its prompt, or, for a tau with an init, leave that to the run's watch. Answers `{ id }`, the session's id. |
| `finish { id }` | Wait until the run ends, and answer `null`, then send its result, the same each time; the caller's adaptor checks it, and puts what it gave back at the caller's paths. |
| `release { id }` | Stop the run's init, if it runs, archive the session, which stops its turn, remove its box, running or not, and forget the run, and every run it started. |
| `list {}` | Every run, oldest first, as `status` gives each. |
| `status { id }` | Where the run is, `running`, `ended` or `finished`, its prompt, and once it ended, when and how: `{ ok, text, failure? }`; and the run that started it, its `parent`, if one did. |
| `history { id }` | The run's session's history, ended or not (below). |

Each of the service's operations takes who calls it, a run's caller,
which the way in says, never the request: the host's `tau`, through the
socket, which reaches every run; or a session, which reaches only the runs
it started: any other is as if it were not there. Who calls makes no
difference to a run's files, which only the caller reads and writes. The
plugin provides the service as `ctx.fleetTau`, whose `handlerFor(caller)`
serves the requests as `caller`'s, to the sessions' two ways in, each
with tau's client and its fleet adaptor:

- a tau's session calls it from its box, through the `tau` API's extension
  (docs/fleet-ext-tau/index.md), which relays each request, and its runs
  are in its own project;
- another session, such as the web UI's, calls it with `tau_run`
  (docs/fleet-core/tools/index.md), in this process, and its runs are in
  its working directory, which it names as the host's `tau` names its
  folder.

The patch also declares `tau`, the agent preset a tau's session has, last
in the web UI's list: a persona, the tau's prompt plugin
(`@sleepymug/fleet-core/preset/prompt`), the box's reset notice
(`@sleepymug/fleet-core/preset/reset`), the tools as they are, whatever the
host presents; in its `box` group, its world, the box's file system and
subprocess runtime (docs/fleet-core/world/index.md), and over them dsh's
local bash, bash in the foreground only, whose commands run until they
end, unless the model gives one a timeout, since a program that runs taus
waits for each, read/write/edit, the tau's skills; and compaction. What its rows register reaches only the sessions
of that preset: dsh mounts them once, in the preset's scope, which each of
its sessions' agents has as its parent. Every other preset is dsh's, as
the web UI's sessions have them.

`ctx.fleetTauRuns` is typed by what each that builds on it uses
(`ports.ts`): the service, `RunLifecycle`, the runs' lifecycle; and
fleet-core's world (docs/fleet-core/world/index.md), the `tau` preset's
plugins and `tau_run`, `TauBoxes`, which sessions are a tau's and their
boxes:

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

- **Setting up the box** (`runs.ts`), the first part of a submit, goes in
  this order:
  1. It admits the call as it comes (`admission.ts`), before it keeps
     anything or makes a box, writing it to the session's folder,
     `$DSH_HOME/fleet/taus/<session id>/call.tar`, as it reads it: tau's
     `decodeCall` checks it whole, as tau's docs/spec/serialization.md has
     it, and the tau it carries, which comes first, is extracted beside it,
     and removed once the call is admitted, or refused.
     tau's backend SDK admits the call (`admit`): it checks the envelope
     against `tau.json`, each file's mode and kind, each extra file's
     name, and the args against the schema, and finds each API an
     implementation in the catalog of the extensions provided
     (`apis.ts`), `ctx.fleetExts`, the extension of its contract whose
     version serves the copy's, as tau's `serves` has it. A tau with an API
     whose contract no extension implements, or at no version that serves
     the copy's, is refused. Where the box places each file is the box's.
     Problems name the tau by the run's title. Here `session-<uuid>` is
     minted, the form dsh's session ids take, which the dsh session gets.
  2. It creates the box `fleet-tau-<uuid>`, starts it, and has the box's
     runtime set it up from the call (`box-setup.ts`; fleet-box-runtime's
     tau runtime, below), offered the contracts the call was admitted with, which
     reports the prompt, where things are, and which client each API
     needs; copies each client in, where the runtime says; has the helper
     link the APIs and what the tau exposes (`apis.link`); and stops it.
  3. It writes the registry entry, with the files it checked and what the
     runtime reported; the call stays until the run is released.

  A failure removes the box and the session's folder. A tau's session's
  run is in the session's own project; the host's in the folder it names,
  through its symlinks.
- **The box's runtime** (fleet-box-runtime/tau): the box's half of the
  backend, built on tau's backend SDK, in the image, which owns where a run
  has its things in its box. The host runs it in a run's box with `docker
  exec` (`Box.pipe`), since the helper's lines of JSON would carry the
  archives only as text, each command as fleet-box-runtime/tau/protocol
  makes and reads it:
  - `setup '{"offered": […]}'` reads the call on its stdin with tau's
    `unpackCall`: it places the tau, admits the call against it, with a
    catalog of the contracts offered, each one's client at
    `/tau/node_modules/.fleet/<contract>`, gives each file its place
    (./layout.ts), places the content of the `in` and `inout` files
    there, and checks them (`place`); then it expands the args, the prompt,
    and the tau's init, if it has one, with the places (`expand`), makes
    each `out` folder and each client's, keeps the files, their places and
    the args the agent sees in `/tau/.run.json`, puts tau's `TAU.md` and
    `TAU_DEV.md`, as its tau library has them, in `/tau`, and reports
    `{ prompt, cwd, places, modules, self, init?, links, packages }`: the
    prompt, the agent's working directory, each file's place, where the
    APIs go, where the tau is, the init, each
    API with its contract and where its client goes, and the packages of
    the tau's own it exposes. It runs before the agent, on a call the host
    admitted, and runs no code of the tau's, so the host takes its report
    as its own, once it has its shape, linking only clients it offered.
  - `pack` writes the result on its stdout, as the backend SDK collects
    it, from what the agent left at each `out` and `inout` file's place,
    checked with `checkOutputs`, or a failure that says why it does not
    fit. The result is checked on the host after it leaves the box, since
    the box is the agent's by then.
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
  | the client of each API's extension | `/tau/node_modules/.fleet/<contract>` |
  | tau's `TAU.md`, what a tau takes and what a run of one promises, for the agent to read | `/tau/TAU.md` |
  | tau's `TAU_DEV.md`, how to make a tau, for the agent to read | `/tau/TAU_DEV.md` |

  A place keeps its base name, as tau's backend SDK asks: a file whose
  base name is taken in its folder is in a folder of its own there, named
  for the file, with a suffix if that is taken too: `/tau/in/notes.md`,
  then `/tau/in/extra/notes.md` for the file `extra`. An `out` file has no content
  in a call. Its folder is made for a `dir`, and only its parent for a
  `file` or one that may be either, since the agent makes what it leaves.

  Node looks for a package in every folder above the file that imports it,
  so code anywhere below `/tau`, the tau's own packages included, finds
  `/tau/node_modules`, and TypeScript does too. The agent runs its programs
  from the tau's own directory, with bash's `node -` and `workdir`
  `/tau/self`, Node reading the
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
  name, mode, kind and base name, what `tau.json` says it is, and its
  place, as the runtime reported it), the working directory and
  the APIs' folder in the box, as the runtime reported them, the contracts of the
  APIs the tau holds, each linked, what it exposes, with what each says it is,
  the names of its skills, when it was made, when it was given its prompt, when and how its run
  ended, when a `finish` first gave that back, and when the box was last
  set up again, if it was. Beside it, a folder of
  the session's own, `$DSH_HOME/fleet/taus/<session id>/`, holds the call,
  `call.tar`, and the run's result, `result.tar`, until the run is
  released. An entry is
  written last, so an entry means a box that is set up, and before the dsh
  session is made. A service started later finds its sessions there. Only
  ids of the form the service mints name an entry, since they are file
  names.
- **Starting the run**, once its box is set up: the submit starts the box,
  then, through dsh's workspace registry and session controller:
  1. makes the project a dsh workspace, or finds the one it is;
  2. makes the session with the entry's id, in that workspace, with the
     `tau` preset, gives it dsh's `danger-full-access` permission preset,
     no sandbox and approval `never`, in its log, since its box is its own
     and nothing in it waits on a person, and titles it with the run's
     title;
  3. queues the prompt under the entry's request id;
  4. records in the entry when the session got its prompt.

  For a tau with an init, the submit stops after step 2, and the run's
  watch runs the init first (below), then takes steps 3 and 4 unless the
  init did the run.

  A failure on the way archives the session and removes the box and the
  entry, so a run either started or left nothing. A session's operations
  run one after another, so its start, its end, a finish and a release
  keep their order.
- **The init** of a tau that has one (`init.ts`, tau's docs/spec/init.md)
  runs as its run's watch begins: the helper spawns `sh -c` with the
  command, `${self}` expanded as `/tau/self` by the box's `setup`, in the
  agent's working directory, `/tau/workspace`, as `spawn` does a bash
  command of the agent's, with `$FLEET_SOCKET`, so a program of the tau's,
  such as `node ${self}/init.mts`, imports what the agent's programs do,
  and its API calls are the session's, nested runs included; it occupies the box until it exits. Its exit says what comes
  next, as tau's `initDecision` says: 0, `TAU_SKIP`, ends the run without the agent, which the session
  never gets a prompt for, init's stdout its text, and the run succeeds as
  if the agent had, packing what init left (below); 100, `TAU_RUN`, gives
  the session its prompt as it is; 101, `TAU_FALLBACK`, and any other
  exit, or a signal, gives it the prompt followed by a note that init
  failed, how it ended, and what it wrote to stdout and stderr, each in a
  fenced block. An init that cannot run at all fails the run. Releasing
  the run kills the init's process group;
  a host that stops meanwhile kills it too, and the run then ends as one
  whose start was cut short before its prompt.
- **A run ends** at the first time its agent is done with its prompt: the
  service waits for the agent's `whenIdle()`, then reads the session's log
  with the session controller's `inspect` (`dsh/outcome.ts`). The run succeeded
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
  again, `decodeResult`, which checks each output's content as it comes,
  and checks its report against the run's files, `checkReport`: an output
  for each `out` and `inout` file, of its kind, and the agent's own text. One that
  does not fit fails the run. A run that failed gives nothing back: its
  result, which the host writes, holds how it ended alone.
- **Finishing** waits for the run's end, which a client that goes away
  gives up, leaving the run as it is. Then it sends the result; the first
  time, it records the finish in the entry. The caller's adaptor checks
  the result, as tau's docs/spec/protocol.md asks, and puts what it holds
  at the caller's paths, which the service never learns. The service
  sends the same again, so a client that lost its connection, as when dsh
  restarts, asks again, and a client other than the one that started the
  run, sharing its run store, can finish it.
- **A run's history**, for a caller to inspect it, is its session's events,
  oldest first, as dsh's session controller inspects them: the prompt, each
  request's system prompt and tools, each model message, tool call and
  result, and each turn's end, read when asked, ended or not, failed run
  or not. It is dsh's, not tau's spec's, so its form is dsh's session
  log's, and the caller writes it where it wants it.
- **The runs a run started** go with it. Once a run ends, its box is
  stopped, and nothing it started and did not finish can give anything
  back, so those runs are released. Releasing a run releases every run it
  started first, finished or not, and theirs.
- **Releasing** stops the run's init, if it runs, and archives the
  session, stopping its work, since dsh does not delete sessions; then it
  removes the box and the session's folder, and forgets the session. It is
  the only way to stop a run, as tau's protocol has it. A
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
  `preset/prompt.ts`. After the persona, which says the model runs a tau
  whose prompt is its task, a section, `fleet:tau-where`, says where the
  model works: its box, as root, with the network, and what it has; its
  working directory, `/tau/workspace`; and the tau's own directory,
  `/tau/self`, which it reads but does not change. It says how the run
  ends: no one answers the model, its last message is the run's text, and
  its caller gets that, its `out` and `inout` files and what its API calls
  did, and nothing else it writes. And it says where tau's `TAU.md` and
  `TAU_DEV.md` are. From the session's registry entry, after it: a
  section, `fleet:tau-files`, lists the run's files, each with its mode, its
  kind, its place and what `tau.json` says it is, and says what each mode
  asks, that the run fails unless the agent leaves each `out` and `inout`,
  and that a directory merges into the caller's; and, for a tau that
  exposes something, a section, `fleet:tau-programs`, says to run programs
  with bash's `node -`, `workdir` `/tau/self`, with absolute paths, and
  lists what they import: each exposed API or package, with where it is
  declared and what it says it is. The tau's descriptions are not
  interpolated, as dsh's prompt variables would be.

  The assembly (the `system-prompt/assemble` waterfall) leaves out by name
  dsh's sections about the host, which are false in a box: the harness's
  identity (`harness:identity`), which the persona says in its place, its
  checkout (`harness:source`), the web GUI at its URL (`app:web-surface`),
  the web UI's file cards and links (`ui:deliverable-file-references`),
  and `@` mentions as host paths (`context:file-reference`), the last
  registered in each agent's own scope, which a section of the preset's
  cannot shadow. It leaves out the runtime contexts on the sandbox policy
  (`sandbox:policy`), the host's file policy, and the approval policy
  (`approval:policy`), which asks not to widen a sandbox the box does not
  have. It says once, in `tool:write`'s place, what write's and edit's
  sections each say, that a file is read before it is changed. It gives
  bash a description of its own, in place of dsh's, whose file sandbox,
  `$DSH_*` variables and spill files are the host's: a fresh shell in
  `/tau/workspace`, a command that runs until it ends, unless given
  `timeoutMs`, and long output written to a file. And it drops the `skill`
  tool for a tau without skills. The web UI's own sessions keep dsh's
  whole prompt.
- **Its tools are its preset's.** Each tool registered at the top, for
  every session, such as `tau_run`, works on the host, so the prompt plugin
  hides each from the preset's agents (`ctx.tools.restrict`, in the
  preset's scope), as each is registered, since dsh mounts the preset as
  it starts, maybe before another plugin registers its tool; and the
  preset presents the tools as they are, so a program the model writes
  runs in the box, with bash's `node`, not on the host, as PTC's
  `run_code` would under dsh's `DSH_TOOLS_MODE`. The web UI's Permissions
  selector changes nothing for a tau's session: its tools have no sandbox
  but its box.
- **tau's primers are no skills in a box.** Every session on the host has
  `TAU.md` and `TAU_DEV.md` as the skills `tau` and `tau-dev`
  (docs/fleet-core/tools/index.md), which the prompt plugin shadows in the
  preset's layer of dsh's skill registry with skills of the same names the
  model cannot load, so a tau's session lists neither, and reads the files
  in its box.
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
- **Each session's box** (`session-box.ts`) is one object, which keeps
  all that is the box's: its container, opened once; its operations, one
  after another, so that a start, a stop, a copy, a pack and a release keep
  their order; whether it was started here; what occupies it, and the
  pending stop of a box nothing occupies; what waits for it to start; the
  host files copied in; and whether it is archived. It is given its
  container's name, Docker's boxes, the platform, its idle time, what
  answers its clients' calls, and what sets it up again from the run's
  call, which the runs do.
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
  caller can still finish it, and only releasing it forgets it. While the
  session is archived, `boxFor` fails, and so does the world's work in the
  box. A session that no longer is archived has no box until its next use.
- **A box gone is set up again** from the run's call, which the session's
  folder keeps, when `boxFor`, a start for a `pack`, or a copy next needs
  it: after an unarchive, or a box removed by other means. The call is
  admitted again, its APIs found in the extensions provided now,
  so one no longer provided fails the set-up, and the box is created under
  its name, set up by its runtime, given the clients and linked, as when
  the run started; the entry records the files, the working directory,
  the APIs and what the tau exposes as they are now, and when. The box is
  then as it was when the run began: what the agent did in it is gone.
- **The agent is told** (`preset/reset.ts`). Before each step of a
  tau's session that sends messages, the plugin has the box ready, through
  `boxFor`, so a failure to set it up fails the step rather than a tool
  call. A session that is not a tau's, as one a person gives the preset in
  the web UI, has no box, so each step fails, saying the preset is for the
  runs `tau run --adaptor fleet` and `tau_run` start, before the model is asked
  anything; and its tools reach nothing of the host. When the box was set up again since the agent was last told, a
  notice goes before the step's messages, saying so, and that what the
  agent's API calls did stands, so it does not make them again: a user message with a
  source of its own, `fleet-tau-box`, which the session's log keeps, and
  which a projection of the log folds into the setup it told of.
- **A box gone** when the session is deleted still lets the session be
  forgotten.
- **The socket**, as tau's `listenFleet` serves it (tau's
  docs/spec/fleet.md#the-socket), has mode 0600, and its folder is made
  with mode 0700, so only the owner can open it. That is its
  authentication, as it is for the dsh home's own files. It takes one
  request per connection: one line of JSON in, with a submit's call after
  it, up to the end of what the client sends, and one out, with a finish's
  result after it. A socket a service answers on is not taken over; one
  left by a service that died is.
- **The requests** (`wire.ts`), however they come, go through one
  handler, `handlerFor(caller)`: tau's `readFleetRunRequest` checks a
  run's, and the handler the service's own, so what a box sends is
  checked as what the host does.
- **Printing.** The service prints what it does, the expanded prompt
  included, through its platform's `log` (docs/fleet-core/index.md): on
  dsh's stderr, after `fleet-tau:`. dsh's logger shows no info.
- **dsh, through one interface.** The service reaches dsh's sessions only
  through `Sessions` (`service.ts`), which `dsh/sessions.ts` implements
  with `ctx.sessionController` and `ctx.workspaceRegistry`, as the web
  client's own calls go, so the web UI follows the session live, and which
  reads how a session ended from its log as a run's result
  (`dsh/outcome.ts`), so the service knows nothing of dsh's turns. The
  plugin follows the archived sessions (`dsh/archive.ts`) and the agents'
  turns (`dsh/turns.ts`) through dsh's events. Each imports only dsh's
  types; the plugin's config gives it the dsh home, as `dshHomePath()` in
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
  the agent removed there stays, which the agent and the caller are told.
- A bash command in a box has no timeout of its own: one that waits for
  input, or serves, holds the run until it is cancelled, through dsh. A
  later design of limits may bound it.
- A finish gives back the result its box packed when the run ended; what
  a person asks the run's session in the web UI later is not collected
  again, though tau's protocol lets a finish give the latest result.
- A finish whose connection is lost, as when dsh restarts, fails; the
  host's `tau finish` asks again when run again.
- A box left by a dsh that died while it set up a run stays. `fleet-box list` shows
  it as `fleet-tau-…`, and `fleet-box delete` removes it.
- The `tau` preset is in the web UI's list of presets, and its settings'
  default, since dsh has no hidden preset; a session given it fails each
  step.
- fleet-core depends on dsh-base's row ids, `fs-sandbox`, `subprocess` and
  `spill-local`, whose modules its world mounts in their place; a profile
  that provides one of their services under another row has two providers
  of it.

## Built on

- dsh's `domain/changed` (`@deepseek-ai/dsh-storage-domain`), for the
  archived sessions; `agent/pre-step`, `@deepseek-ai/dsh-llm`'s
  `createUserMessage` and `@deepseek-ai/dsh-session-projection`, for the
  notice.
- `@sleepymug/tau`: the backend SDK, `@sleepymug/tau/backend` (`admit`,
  `initDecision`); the core's `checkReport` and `serves`; `wire-tar`'s
  `decodeCall`, `decodeResult` and `packResult`; `transfer`'s
  `extractContent`; and the fleet adaptor's `listenFleet` and
  `readFleetRunRequest`, `@sleepymug/tau/adaptors`.
- `ctx.fleetExts` (fleet-core/ext).
- `Box` and `exec` (`@sleepymug/fleet-core/box`), with `Box.pipe` for the archives
  the box's runtime reads and writes, and fleet-box-runtime's tau runtime, in
  the image.
- `@sleepymug/fleet-protocol/tau`, for the service's own requests.
- dsh's session controller, workspace registry and agents
  (`@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-workspace`,
  `@deepseek-ai/dsh-agent`), and `@deepseek-ai/dsh-permission-presets`,
  for a session's full access.
- `@deepseek-ai/dsh-agent-preset`, `dsh-agent-tool-presentation`,
  `dsh-bash-local`, `dsh-tool-bash`, `dsh-tool-fs`, `dsh-skill-filesystem`
  and `dsh-tool-skill` for the `tau` preset, and `@deepseek-ai/dsh-tools`
  for hiding the host's tools.

## How it runs

dsh's `web` profile lists fleet-core after dsh's base and web bundles, in
`$DSH_HOME/profiles/web/package.json`:

```json
{
  "dependencies": { "@sleepymug/fleet-core": "link:<checkout>/packages/fleet-core" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@sleepymug/fleet-core"] } }
}
```

`pnpm exec dsh plugin --profile web add link:<checkout>/packages/fleet-core`
makes it so, the profile made from dsh's web template if it was not
there; each extension is a bundle listed after fleet-core, added the same
way, such as `link:<checkout>/ext/fleet-ext-notes`. The web UI's sessions
stay as dsh has them, with `tau_run` added. docs/install.md installs it
all from npm instead.

After `pnpm build` and `pnpm image`, `pnpm exec dsh web`, with
the dsh the workspace pins, starts the service with the web host, and
`tau --adaptor fleet` and `fleet` talk to it
(docs/fleet-client/index.md). On dsh's stderr:

```
fleet-tau: created session-4a65… in box fleet-tau-4a65…, with the prompt:
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
fleet-tau: started session-4a65… in /home/me/notes, and gave it its prompt
fleet-tau: session-4a65… ended
fleet-tau: released session-4a65…, and removed its box fleet-tau-4a65…
```
