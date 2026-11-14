# dsh-tau/tau

The tau backend, the backend of tau's rpc adaptor (tau's
docs/spec/rpc.md): tau's client, the `tau` command or its SDK, hands it
runs, and the backend runs each as a box on fleet's gateway
(docs/fleet/index.md) and a dsh session, watches it until its agent is
done, then gives back how it ended, with what it left at its `out` and
`inout` files, and releases runs. It runs in dsh's process, in the profile
dsh-tau is installed in, such as dsh's `web` (docs/install.md), beside the
gateway, which runs on its own. It is built on tau's backend SDK (tau's
docs/spec/backend.md). A run comes as a **call** and goes back as a
**result**, the archives of tau's docs/spec/serialization.md: the caller's
adaptor packs the call from its files, and checks the result and puts it
at its paths, so the backend never learns a caller's paths, and serves a
caller on the host and one in a box alike. A submit mints the session's
id, makes the run's box on the gateway, lays it out from the call, here,
on the host, and expands its prompt, then makes the dsh session, in the
caller's folder as its workspace, so the web UI lists it there, and gives
it the prompt, once the tau's init, if it has one, asks for the agent. The
session's bash and file tools work in its box, through dsh-tau's world
(docs/dsh-tau/world/index.md). Once the run ended, what it gave back is got
back from the box, here too, so nothing of the backend runs in a box. And
the backend is served as the tau service, through the gateway, whose
package, tau, puts the `tau` command in every box, whose runs are that
box's run's, and which the host's `tau` command reaches as a client of the
gateway.

## Provides

Four dsh plugins, which dsh-tau's `cordis.patch.yml` mounts:

- `fleet-tau-runs` (`@sleepymug/dsh-tau/tau/runs-plugin`): the runs of
  taus and their boxes (`runs.ts`), as `ctx.fleetTauRuns`, and the client
  of fleet's gateway, as `ctx.fleet`. It uses nothing of dsh's. The runs
  put together what a run needs: its admission (`admission.ts`), its box's
  layout and its result, here on the host (`placement.ts`, its places
  `layout.ts`'s), the registry (`registry.ts`), and each session's box
  (`session-box.ts`), all on the gateway through its `FleetPort`
  (`ports.ts`). Its config:

  | Field | What it is |
  |---|---|
  | `dshHome` | The dsh home, absolute, as `dshHomePath()` in the patch. |
  | `fleetSocket` | The gateway's clients' socket; unset, `$FLEET_SOCKET`, or `fleet.sock` in the fleet home (docs/fleet-protocol/index.md). |
  | `image` | The image of a run's box; unset, the gateway's own. |
  | `idleStopMs` | How long a run's box, started, runs while nothing occupies it before it is stopped; unset, a minute. The patch sets 60 s. |

- `fleet-tau-model` (`@sleepymug/dsh-tau/tau/model-plugin`): the model
  every tau's session starts on (`model.ts`), in place of dsh's default, as
  `ctx.fleetTauModel`, which the `tau` preset gives it (below). Its config
  is the model's fields alone, each unset by default, to follow dsh's
  default model, which a person picks in the web UI:

  | Field | What it is |
  |---|---|
  | `provider`, `model` | The route, together, as dsh's model picker names them: a provider of dsh's and its id of a model. |
  | `reasoningEffort` | The reasoning effort, as the provider names it; unset, the route's own, or, without a route, dsh's default's. |

  A profile sets them with a row of its own, which replaces the row's
  whole config, so it states nothing else:

  ```yaml
  - id: fleet-tau-model
    config: { provider: openai-codex, model: gpt-6-astra, reasoningEffort: high }
  ```

  Each field is volatile, so a change, in the profile's patch or through
  dsh's settings, as the web UI's tau model page makes it
  (docs/dsh-tau/client/index.md), reaches the next tau's session to
  start, and mounts nothing again. A provider without its model, or a
  model without its provider, fails the plugin as it loads, or, changed
  later, the first request of each tau's session that starts.
- `fleet-tau-lanes` (`@sleepymug/dsh-tau/tau/lanes-plugin`): the cap
  on how many of the taus' model calls stream at once (`lanes.ts`), over
  dsh's `llm/stream`. Its config is one field, unset by default, for no
  cap:

  | Field | What it is |
  |---|---|
  | `lanes` | How many of the taus' model calls stream at once, at most, a whole number from 1. |

  A profile sets it with a row of its own, as fleet-tau-model's:

  ```yaml
  - id: fleet-tau-lanes
    config: { lanes: 4 }
  ```

  It is volatile, so a change, in the profile's patch or on the web UI's
  tau lanes page (docs/dsh-tau/client/index.md), reaches the next call
  to take or give back a lane, and mounts nothing again.
- `fleet-tau` (`@sleepymug/dsh-tau/tau/plugin`): the tau backend
  (`service.ts`). It builds on `ctx.fleetTauRuns`, `ctx.fleet`,
  dsh's session controller, its workspace registry and its agents. It
  serves the backend as the tau service through the gateway
  (`tau-service.ts`, below), with `ctx.fleet.serve`, its registration
  closed as the plugin unloads: `tau.v1.Runs`, tau's rpc adaptor's service
  (tau's docs/spec/rpc.md), each call as `backend.ts` has the backend
  serve it:

| Method | What it does |
|---|---|
| `Submit`, `{ start: { title, project? } }`, then the call | Start a run of the call, which carries the tau: admit it, make its box on the gateway and lay it out, make the dsh session, titled `title`, in the dsh workspace of `project`, and give it its prompt, or, for a tau with an init, leave that to the run's watch. Answers `{ id }`, the session's id. A call that does not fit its tau, or breaks the spec, and a run from outside a box that names no absolute `project`, are `invalid_argument`. |
| `Status { id }` | Where the run is, at once, as tau's status has it: `{ running }`, or, once it ended, `{ ended: { result: 1, ok, failure? } }`, a run having one result. |
| `Result { id }` | Answer `{ result: 1 }`, then send the run's result, the same each time, at once, refused while the run is running, `failed_precondition`; the caller's adaptor checks it, and puts what it gave back at the caller's paths. |
| `Trace { id }` | The run's trace, `{ format: "dsh-session-events", events }`, its session's events, ended or not (below). |
| `Release { id }` | Stop the run's init, if it runs, archive the session, which stops its turn, remove its box, running or not, and forget the run, and every run it started. |

A run the caller does not reach is `not_found`, as one that is not there.
`ctx.fleetTau.list(caller)`, which no call of the service asks, gives
every run the caller reaches, oldest first, each where it is, `running`,
`ended` or `finished`, its prompt, and once it ended, when and how:
`{ ok, text, failure? }`; and the run that started it, its `parent`, if one
did.

Each of the backend's operations takes who calls it, a run's caller,
which the way in says, never the request: the host, which reaches every
run; or a session, which reaches only the runs it started: any other is as
if it were not there. Who calls makes no difference to a run's files,
which only the caller reads and writes. The plugin provides the backend as
`ctx.fleetTau`, whose `backendFor(caller)` (`backend.ts`) is the backend as
`caller`'s, a `RunBackend` of tau's rpc adaptor, to the three ways in, each
with tau's client and its rpc adaptor:

- the host's `tau` command calls it as a client of the gateway, at
  `/services/tau` on the gateway's clients' socket, as tau's config file
  says (docs/install.md); the gateway tells the service the call is a
  client's, and the backend serves it as the host's, whose runs are in the
  folder it names;
- a tau's session calls it from its box, with the `tau` command there,
  through the tau service, whose calls the gateway carries from the box,
  saying which box each comes from (below); its runs are in its own
  project;
- another session, such as the web UI's, calls it with `tau_run`
  (docs/dsh-tau/tools/index.md), in this process, and its runs are in
  its working directory, which it names as the host's `tau` names its
  folder.

The tau service (`tau-service.ts`, `tauService(sessionOfBox, backendFor)`)
is what the backend serves through the gateway
(docs/fleet/services/index.md), for as long as `fleet-tau` is loaded,
registered before the backend watches any run, since every run's box is
made with it:

| Field | What it is |
|---|---|
| `name` | `tau`, so its path through the gateway is `/services/tau`, and its client `@fleet/tau`. |
| `description` | That it runs taus, each in a box of its own, as the box's run's, with `tau run`, as `/tau/TAU.md` says. |
| `schema`, `services` | tau's own, `descriptors()` and `Runs` of `@sleepymug/tau/rpc`, with its comments, so the gateway makes the client `@fleet/tau` of it, plain objects and all, for every box made with the service. |
| `package` | tau itself, `TAU_PACKAGE`, as installed beside dsh-tau, which the gateway stages and puts in every box made with the service: its `tau` command, linked in `/fleet/bin`, on the box's PATH. |
| `env` | `TAU_ADAPTOR=rpc`, `TAU_RPC_SOCKET=/run/fleet/services.sock` and `TAU_RPC_PATH=/services/tau`, for every process in a box, so the `tau` command runs taus on the service, through the box's services socket. |
| `routes` | tau's `runsRoutes`, each call served by the backend for its caller, as fleet-sdk's `callerOf` reads the gateway's: from a box, the session whose box it is (`sessionOfBox`), a box that is no run's refused, `permission_denied`; from a client of the gateway, the host. |

The patch also declares `tau`, the agent preset a tau's session has, last
in the web UI's list: a persona, the tau's prompt plugin
(`@sleepymug/dsh-tau/preset/prompt`), the box's reset notice
(`@sleepymug/dsh-tau/preset/reset`), the model
(`@sleepymug/dsh-tau/preset/model`), the tools as they are, whatever the
host presents; in its `box` group, its world, the box's file system and
subprocess runtime (docs/dsh-tau/world/index.md), and over them dsh's
local bash, bash in the foreground only, whose commands run until they
end, unless the model gives one a timeout, since a program that runs taus
waits for each, read/write/edit and read_image, the tau's skills; and
compaction. read_image needs dsh's tool-fs mounted through
`@sleepymug/dsh-tau/preset/tool-fs`: tool-fs registers it in a nested
inject, whose `ctx.fs` cordis 4.0.5 cannot find under the group's isolated
`fs`, since it compares isolation keys with the root context's, not the
caller's; the wrapper has each nested inject require tool-fs's own
services, `fs` among them, until cordis looks up with the caller's key.
What its rows register reaches only the sessions of that preset: dsh
mounts them once, in the preset's scope, which each of its sessions'
agents has as its parent. Every other preset is dsh's, as the web UI's
sessions have them.

`ctx.fleetTauRuns` is typed by what each that builds on it uses
(`ports.ts`): the backend, `RunLifecycle`, the runs' lifecycle, and
`sessionOfBox`, the tau's session whose box a box is, for the tau
service; and dsh-tau's world (docs/dsh-tau/world/index.md), the `tau`
preset's plugins and `tau_run`, `TauBoxes`, which sessions are a tau's and
their boxes:

- `isTau(sessionId)`, at once, whether a session is a tau's;
- `boxPath(sessionId, path)`, at once, where a path of a tau's session's
  work is in its box: its project, and what is in it, in `/tau/workspace`;
- `boxFor(sessionId)`, the started box of a tau's session, a `RunBox`, its
  id and `api`, the box API of the started box, which a call does not
  start, the world's own holds keeping it started; started if it is not,
  and set up again from the run's call if it is gone; it fails while the
  session is archived;
- `hold(sessionId, occupant)`, the same, occupied by `occupant`, a turn, a
  terminal, a process, a call or a file call, until its release, so the
  box is not stopped for being idle while it is in use; `occupy` occupies
  it without asking for it to start, as a running agent does;
- `isStarted(sessionId)` and `whenStarted(sessionId, signal)`, whether the
  box is started, as the gateway last said, and the box once something
  starts it, which starts nothing, for a watch;
- `copyInOnce(sessionId, from, to)`, at once, a host file copied into the
  box of a tau's session before its next use, for dsh's attachments: a tar
  archive of the one file, mode 0444, readable by all and writable by none,
  put in the box with `Box.Put`;
- `services(sessionId)`, the services a tau's session's box was made with,
  each as registered now, its name, its description and its commands, for
  its prompt; one no longer registered is left out.

## Design

- **Setting up the box** (`runs.ts`), the first part of a submit, goes in
  this order:
  1. It admits the call as it comes (`admission.ts`), before it keeps
     anything or makes a box, writing it to the session's folder,
     `$DSH_HOME/tau/runs/<session id>/call.tar`, as it reads it: tau's
     `decodeCall` checks it whole, as tau's docs/spec/serialization.md has
     it, and the tau it carries, which comes first, is extracted beside it,
     and removed once the call is admitted, or refused. tau's backend SDK
     admits the call (`admit`): it checks the envelope against `tau.json`,
     each file's mode and kind, each extra file's name, and the args
     against the schema. Where each file is placed is the layout's (below).
     Problems name the tau by the run's title. Here `session-<uuid>` is
     minted, the form dsh's session ids take, which the dsh session gets.
  2. It makes the box on fleet's gateway (`create`), its labels
     `dsh.session`, the session's id, `tau.title`, the run's title, and,
     for a run a session started, `tau.parent`, that session's id; its
     environment `BOX_ENV`, `TAU_CONTEXT=/tau/context.json`; its
     `services`, every service registered at that moment, the tau service
     among them, since the gateway fixes a box's services as it makes it;
     and the config's image, if it names one.
  3. It starts the box, and lays it out from the call (`furnish`, below).
  4. It writes the registry entry, with the box's id, the files it
     checked, and what the layout said; the call stays until the run is
     released.

  The box then stops once it has been idle for the idle time, unless the
  run's start uses it first, as a submit's does. A failure removes the box
  and the session's folder. A tau's session's run is in the session's own
  project; the host's in the folder it names, through its symlinks.
- **Laying out the box** (`placement.ts`, `furnish(box, call, scratch)`),
  on the host, built on tau's backend SDK: the box is the agent's, so
  nothing of the backend runs in it. It reads the call with tau's
  `unpackCall` into a scratch folder of the session's, as the box will
  have it at its root: it places the tau, admits the call against it
  (`admit`), gives each file its place (`layout.ts`), places the content of
  the `in` and `inout` files there, and checks them (`place`); then it
  expands the args, the prompt, and the tau's init, if it has one, with the
  places (`expand`), makes each `out` folder that is a `dir`, writes the
  run's context, `/tau/context.json` (tau's docs/spec/context.md), links
  `/tau/node_modules` to the tau's own, if it has one, puts tau's `TAU.md`
  and `TAU_DEV.md`, as its tau library has them, in `/tau`, and links
  `/node_modules/@fleet` to the box's service clients. It puts the folder in
  the box as one tree, a tar archive unpacked at `/` (`Box.Put`), removes
  the folder, and gives `{ prompt, cwd, places, programs, init?, packages
  }`: the prompt, the agent's working directory, each file's place, the
  program directory, the init, and the packages of the tau's own it
  exposes, each with where it is in the box and what it says it is.
- **Places**, as `layout.ts` has them, each under
  the base name of the caller's path, or, for an `in` given a list of
  paths, the file's name:

  | What | Where in the box |
  |---|---|
  | an `in` file | `/tau/in/<base name>` |
  | an `inout` file | `/tau/workspace/<base name>` |
  | an `out` file | `/tau/out/<base name>` |
  | the tau's own directory, `${self}` | `/tau/self` |
  | the program directory (tau's docs/spec/runtimes.md) | `/tau` |
  | the tau's packages, below it: a link to the tau's own `node_modules/` | `/tau/node_modules` |
  | the run's context, which `TAU_CONTEXT` names | `/tau/context.json` |
  | tau's `TAU.md`, what a tau takes and what a run of one promises, for the agent to read | `/tau/TAU.md` |
  | tau's `TAU_DEV.md`, how to make a tau, for the agent to read | `/tau/TAU_DEV.md` |
  | the clients of the box's services, `@fleet/<name>`: a link to `/fleet/node_modules/@fleet` | `/node_modules/@fleet` |

  A place keeps its base name, as tau's backend SDK asks: a file whose
  base name is taken in its folder is in a folder of its own there, named
  for the file, with a suffix if that is taken too: `/tau/in/notes.md`,
  then `/tau/in/extra/notes.md` for the file `extra`. An `out` file has no content
  in a call. Its folder is made for a `dir`, and only its parent for a
  `file` or one that may be either, since the agent makes what it leaves.

  Node looks for a package in every folder above the file that imports it,
  so a program the agent writes anywhere below `/tau`, such as in
  `/tau/programs`, or pipes to `node -` in its working directory, imports
  the tau's packages by name from `/tau/node_modules`, as the tau's own
  code does from `/tau/self/node_modules`; and a program anywhere in the
  box, below `/`, imports the box's service clients, `@fleet/<name>`, from
  `/node_modules/@fleet`. The tau's own directory is read, never written,
  by what the agent runs.
- **The registry** (`registry.ts`) has one JSON file per session,
  `$DSH_HOME/tau/runs/<session id>.json`: who started the run, its
  caller; the box, the gateway's id of it; the run's title, the
  project, the expanded prompt and the request id it is sent under, the
  tau's init, its expanded command and where it runs in the box, if it has
  one, each file (its name, mode, kind and base name, what `tau.json` says
  it is, and its place, as the layout placed it), the working directory
  and the program directory in the box, as the layout gave them, the
  packages the tau exposes, each with where the box has it and what it
  says it is, the names of its skills, when it was made, when it was given
  its prompt, when and how its run ended, when its result was first given
  back, and when the box was last set up again, if it was. Beside it, a
  folder of the session's own, `$DSH_HOME/tau/runs/<session id>/`, holds
  the call, `call.tar`, and the run's result, `result.tar`, until the run
  is released. An entry is written last, so an entry means a box that is
  set up, and before the dsh session is made; forgetting a session deletes
  its entry first, then its folder. So the entry is what makes a session,
  and a folder without one is what a dsh that died on the way left. A
  backend started later finds its sessions there. Only ids of the form the backend mints name an
  entry, since they are file names.
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
  run one after another, so its start, its end, its result and a release
  keep their order.
- **The init** of a tau that has one (`init.ts`, tau's docs/spec/init.md)
  runs as its run's watch begins: the box runs `sh -c` with the command,
  one `Box.Spawn` call, `${self}` expanded as `/tau/self` as the box was
  laid out, in the agent's working directory, `/tau/workspace`, as a bash command of the
  agent's runs, in the box's environment, with `TAU_CONTEXT`, from which
  it reads the args, and the services' commands on its PATH, so a program of the
  tau's, such as `node ${self}/init.mts`, imports the tau's packages, and
  can run taus with the `tau` command, its runs the session's; it
  occupies the box until it exits. Its exit says what comes next, as tau's
  `initDecision` says: 0, `TAU_SKIP`, ends the run without the agent,
  which the session never gets a prompt for, init's stdout its text, and
  the run succeeds as if the agent had, packing what init left (below);
  100, `TAU_RUN`, gives the session its prompt as it is; 101,
  `TAU_FALLBACK`, and any other exit, or a signal, gives it the prompt
  followed by a note that init failed, how it ended, and what it wrote to
  stdout and stderr, each in a fenced block. An init that cannot run at
  all fails the run. Releasing the run cancels the call, which ends the
  init's process group, SIGTERM, then SIGKILL after five seconds; a dsh
  that stops meanwhile ends it too, and the run then fails, `dsh stopped
  during the run's init`, as the next dsh watches it, its init not run
  again.
- **A run ends** at the first time its agent is done with its prompt: the
  backend waits for the agent's `whenIdle()`, then reads the session's log
  with the session controller's `inspect` (`dsh/outcome.ts`). The run succeeded
  if its last turn completed, and left what its tau declares (below); its
  text is the last its agent wrote. Any other end is a failure, which says
  why: what it did not leave, naming each place in the box; a result got
  back from its box that does not fit the run; cancelled; dsh stopped during the
  run, as dsh disposes of the agent then (`aborted` by `disposed`), or
  closes the cut turn later (`interrupted`); the model's error; and so on.
  The backend keeps the run's result, records how it ended in the entry,
  and has the box stopped as soon as nothing occupies it (`runEnded`),
  which keeps what is in it. What a person does in the
  session later, in the web UI, is the session's, not the run's.
- **Watching.** A run is watched from its start; when the backend loads,
  it watches every run whose entry has not ended, so a run cut short by a
  restart ends there, with dsh's `interrupted`, and one whose start was cut
  short before its prompt ends as a failure that says so. The plugin
  registers the tau service before it loads, so a backend whose service
  another server serves, as another dsh's, `NAME_TAKEN`, fails to load,
  and records nothing.
- **What a run gives back**, once its last turn completed, is got back
  from its box, on the host (`packIn`, `placement.ts`): for each `out` and
  `inout` file, only what is at its place, `Box.Stat`, then `Box.Get`, into
  a scratch folder of the session's, at the same path there. tau's
  `checkOutputs` checks it against the run's files, and `packResult` packs
  it into the session's folder, a symlink packed as a symlink, never
  followed; then the backend reads it again, `decodeResult`, which checks
  each output's content as it comes, and checks its report against the
  run's files, `checkReport`: an output for each `out` and `inout` file, of
  its kind, and the agent's own text. One that does not fit, or that the
  box cannot give, fails the run, its failure naming the box's paths, such
  as `/tau/out/report.md`, not the scratch folder's. A run that failed gives
  nothing back, and nothing is got from its box: its result, which the
  backend writes, holds how it ended alone.
- **Its status and its result** wait for nothing: the caller's client
  asks its status until it has ended, as tau's finish does. Once it has, a
  `Result` call gets the result; the first time, it records in the
  entry that the result was given back. The caller's adaptor checks the
  result, as tau's docs/spec/protocol.md asks, and puts what it holds at
  the caller's paths, which the backend never learns. The backend sends
  the same again, so a client that lost its connection, as when dsh
  restarts, asks again, and a client other than the one that started the
  run, sharing its run store, can finish it. A run has one result,
  numbered 1. `tau_run`, in this process, waits for the run's end itself,
  with `untilEnded`, rather than asking.
- **A run's trace**, for a caller to look into it, is its session's
  events, oldest first, as dsh's session controller inspects them: the
  prompt, each request's system prompt and tools, each model message, tool
  call and result, and each turn's end, read when asked, ended or not,
  failed run or not. Its format, `dsh-session-events`, is dsh's session
  log's, not tau's spec's, which nothing may rely on, and the caller
  writes it where it wants it, as `tau trace` does.
- **The runs a run started** go with it. Once a run ends, its box is
  stopped, and nothing it started whose result it did not take can give
  anything back, so those runs are released. Releasing a run releases
  every run it started first, its result taken or not, and theirs.
- **Releasing** stops the run's init, if it runs, and archives the
  session, stopping its work, since dsh does not delete sessions; then it
  removes the box through the gateway, which a gateway that does not know
  it any more lets be, and the session's folder, and forgets the session.
  It is the only way to stop a run, as tau's protocol has it. A session
  never started is not dsh's, so there is nothing to archive. An archive
  that fails keeps the box and the entry.
- **A run from a box is the box's run's.** The `tau` command in a tau's
  box is tau's client, whose rpc adaptor, as the service's environment
  says, calls `tau.v1.Runs` at `/services/tau` on the box's services
  socket; the box's helper carries each call to the gateway, and the
  gateway to the service, saying which box it comes from, which a box
  cannot say for itself; and the service serves it as the calls of the
  session whose box that is, as the runs know it (`sessionOfBox`). So a run
  a box starts is that session's, in its project, its `parent` that
  session, reached by it alone, besides the host; and the client in the box
  packs the call from the box's files, and puts the result at the box's
  paths, which the backend never learns. A program in the box may call the
  service with its client, `@fleet/tau`, too, as the same session. A box
  that is no run's, such as one a person made with `fleet box create
  --service tau`, runs no taus.
- **The taus share lanes.** Every model call of a tau's session, its
  turns', its compaction's and its title's, whatever its provider, takes a
  lane of `fleet-tau-lanes`' one pool before it reaches its provider, and
  gives it back as its stream ends, however it ends; while every lane is
  taken, it waits, first come, first served. A call is a tau's by the
  session it names (`isTau`); a call of another session, or of none, is
  not counted, since the taus are what runs at scale, unattended. A call
  holds its lane only while it streams, not while its tools run, so a tau
  that waits for the runs it started holds none, and nested runs cannot
  starve one another of lanes. A call waits before its provider has it, so
  its provider's timeouts do not run while it waits; one whose wait is
  given up, as by a stop, an archive or a release, goes on without a lane,
  its signal aborted, so its provider ends it as dsh ends any aborted
  call. The calls are counted with no cap too, so a cap set later counts
  those under way; a raised cap admits waiting calls as the next lane is
  taken or given back.
- **dsh-tau stops an idle box**, since fleet's gateway starts and stops
  none of its own accord (docs/fleet/index.md). A session's box runs while
  anything occupies it: its agent while it runs (`fleet-tau` follows
  `agent/status` and `agent/disposed`, and occupies the box without
  starting it), and the world's file calls, processes and terminals, each
  through `hold` from before it asks for the box until nothing of it can
  reach the box. A box that is started, as the gateway's watch tells it,
  and that nothing occupies, is stopped after the idle time, unless
  something occupies it again meanwhile; its next use starts it again. So
  is one started by other means, as with `fleet box sh`, or left running by
  a dsh before this one, which the runs follow from when they load. A
  run's end has its box stopped at once, unless something occupies it,
  such as a user's terminal, and then as soon as nothing does; the runs
  loaded, a run that ended has the same. `boxFor` occupies for no longer
  than it asks, so a box it starts for no one stops once it is idle. As
  dsh exits, the runs stop every box that is started, since nothing of
  theirs can use it after; a dsh that dies leaves its boxes running, until
  the next one loads.
- **One `SessionBox` per session** (`session-box.ts`) keeps all that is
  the box's on dsh-tau's side: the box's id, which a box set up again
  changes; the session's operations on it, one after another, so that a
  start, a stop, a copy, a pack and a release keep their order; what
  occupies it, and the stop of the box once it is idle; its state, as the
  gateway tells it, which it follows from when the runs know the session;
  what waits for it to start; the host files copied in; and whether it is
  archived. It is given its box's id, the gateway, the platform, the idle
  time, and what sets it up again from the run's call, which the runs do.
- **Which sessions are a tau's.** The runs read the registry's entries when
  the plugin loads, each session's project and box with its id, and keep
  them as sessions are created and deleted, so that `isTau` and
  `sessionOfBox` answer at once, as a process's start, which cannot wait,
  needs.
- **Loading sweeps what a dsh that died left**, before any run is set up:
  a session folder without an entry, the session's boxes, labelled
  `dsh.session` with its id, then the folder; and the boxes labelled with a
  session that has an entry, other than its entry's box, made as its box
  was set up again. A box labelled with a session this registry does not
  know, as another dsh's on the same gateway, is let be; what cannot be
  removed now is logged, and swept as the runs next load.
- **Archiving removes the box.** The plugin follows which sessions dsh has
  archived, through the workspace registry's writes (`domain/changed`),
  since archiving has no event of its own, and tells the backend, as it
  loads and on each change. A run whose session is archived, or whose
  caller is, or the caller's caller, and so on through the registry's
  callers, has its box removed through the gateway once the run has
  ended, since the run's result is got back from the box as it ends: a
  stop-and-archive cancels the run's turn, and the run ends soon after.
  Its entry, call and result stay, so its caller can still take its
  result, and only releasing it forgets it. While the session is archived,
  `boxFor` fails, and so does the world's work in the box. A session that
  no longer is archived has no box until its next use.
- **A box gone is set up again** from the run's call, which the session's
  folder keeps, when a start of it fails because the gateway says it is
  gone (`BOX_GONE`), its container removed by other means, or does not
  know it (`NO_BOX`), as after an unarchive: the call is admitted again,
  a new box made with the same labels and environment, and every service
  registered now, laid out from the call, as when the run started, and the
  entry records its id,
  the files, the working directory and what the tau exposes as they are
  now, and when. The box is then as it was when the run began: what the
  agent did in the box is gone.
- **The agent is told** (`preset/reset.ts`). Before each step of a
  tau's session that sends messages, the plugin has the box ready, through
  `boxFor`, so a failure to set it up fails the step rather than a tool
  call. A session that is not a tau's, as one a person gives the preset in
  the web UI, has no box, so each step fails, saying the preset is for the
  runs the `tau` command and `tau_run` start, before the model is
  asked anything; and its tools reach nothing of the host. When the box was
  set up again since the agent was last told, a notice goes before the
  step's messages, saying so, and that what the commands of its box's
  services did stands, so it does not do it again: a user message with a
  source of its own, `fleet-tau-box`, which the session's log keeps, and
  which a projection of the log folds into the setup it told of.
- **The system prompt** of a tau's session is dsh's, shaped by
  `preset/prompt.ts`. After the persona, which says the model runs a tau
  whose prompt is its task, a section, `fleet:tau-where`, says where the
  model works: its box, as root, with the network, and what it has; its
  working directory, `/tau/workspace`; and the tau's own directory,
  `/tau/self`, which it reads but does not change. It says how the run
  ends: no one answers the model, its last message is the run's text, and
  its caller gets that, its `out` and `inout` files and what the commands
  of its box's services did, and nothing else it writes. And it says where
  tau's `TAU.md` and `TAU_DEV.md` are. From the session's registry entry,
  after it: a section, `fleet:tau-files`, lists the run's files, each with
  its mode, its kind, its place and what `tau.json` says it is, and says
  what each mode asks, that the run fails unless the agent leaves each
  `out` and `inout`, and that a directory merges into the caller's; for a
  tau that exposes a package of its own, a section, `fleet:tau-programs`,
  says to write programs anywhere below `/tau`, such as in
  `/tau/programs`, or pipe them to `node -` in the working directory, so
  that they import the tau's packages by name, and lists each exposed package, with where it is and what it says
  it is; and, from the services the box was made with, as the gateway
  lists them now, a section, `fleet:tau-services`, lists the box's
  services, each with its client, `@fleet/<name>`, its commands, if it has
  any, which are on the PATH, and what the service says it is, such as
  `tau`, dsh-tau's own; and says that a program anywhere in the box imports
  a client by its name, whose methods take and give plain objects, and
  whose `index.d.ts`, in `/fleet/node_modules/@fleet/<name>`, says what each
  does, and that the box README, `/fleet/README.md`, says how to call them,
  with curl too. None of the descriptions are interpolated, as dsh's prompt
  variables would be.

  The assembly (the `system-prompt/assemble` waterfall) leaves out by name
  dsh's sections about the host, which are false in a box: the harness's
  identity (`harness:identity`), which the persona says in its place, its
  checkout (`harness:source`), the web GUI at its URL (`app:web-surface`),
  the web UI's file cards and links (`ui:deliverable-file-references`),
  and `@` mentions as host paths (`context:file-reference`), the last
  registered in each agent's own scope, which a section of the preset's
  cannot shadow. The preset suppresses dsh's runtime context, the facts
  dsh sends the model before each step, all of them the host's, such as
  its file policy and its working directory, the session's on the host,
  where the web UI files the session: suppressed, dsh still sends the
  contexts it requires, of which a tau's session has the working
  directory's (`working-directory:current`) alone, so the preset registers
  its own of that name, empty, which shadows dsh's for the preset's
  sessions. It says once, in `tool:write`'s place, what write's and edit's
  sections each say, that a file is read before it is changed. It gives
  bash a description of its own, in place of dsh's, whose file sandbox,
  `$DSH_*` variables and spill files are the host's: a fresh shell in
  `/tau/workspace`, a command that runs until it ends, unless given
  `timeoutMs`, and long output written to a file. And it drops the `skill`
  tool for a tau without skills. The web UI's own sessions keep dsh's
  whole prompt.
- **A tau's session starts on `ctx.fleetTauModel`'s model**
  (`preset/model.ts`), as every other session starts on dsh's default, and
  a person switches it in its chat box as any session's. dsh's session
  controller gives a request a session's own model: the one picked in its
  chat box, then its last request's, which its log keeps, then dsh's
  default, through two waterfalls, `system-prompt/assemble` and
  `agent/request`, with listeners it registers in the agent's scope before
  dsh mounts the preset. The preset's listeners are prepended, so they wrap
  the controller's, and take the default's place alone: before the
  session's first request, with no model picked. That request goes to the
  route, with its effort, or with none, the route's own, as dsh's
  default's effort is not the route's; or, without a route, to dsh's
  default, with the effort, if one is given; and the prompt names its
  model, as the persona's `{{model}}`. Every later request is the
  controller's, so a session keeps its model, through a change of
  `fleet-tau-model`, an archive or a restart of dsh, until a person
  switches it. The web UI's own sessions start on dsh's default.
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
  (docs/dsh-tau/tools/index.md), which the prompt plugin shadows in the
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
  box, where its `inout` files are, as the layout gave it. dsh runs
  a session's work in its workspace's folder, the project, a host path the
  box does not have; the runs' `boxPath` puts that folder, and any path in
  it, in the working directory instead, for every process, terminal and file call the
  world serves from the box.
- **A box gone** when the session is deleted still lets the session be
  forgotten.
- **The calls**, however they come, through the gateway or in this
  process, go through tau's `runsRoutes`, which checks each request as from
  a client the backend does not trust, and then to the backend for its
  caller, `backendFor(caller)`, so what a box sends is checked as what the
  host does. The host's are its owner's alone, as the gateway's clients'
  socket is (docs/fleet/index.md); a box's caller is the box the gateway
  says, never what the box says.
- **Printing.** The backend prints what it does, the expanded prompt
  included, through its platform's `log` (docs/dsh-tau/index.md): on
  dsh's stderr, after `dsh-tau:`. dsh's logger shows no info.
- **dsh, through one interface.** The backend reaches dsh's sessions only
  through `Sessions` (`service.ts`), which `dsh/sessions.ts` implements
  with `ctx.sessionController` and `ctx.workspaceRegistry`, as the web
  client's own calls go, so the web UI follows the session live, and which
  reads how a session ended from its log as a run's result
  (`dsh/outcome.ts`), so the backend knows nothing of dsh's turns. The
  plugin follows the archived sessions (`dsh/archive.ts`) and the agents'
  turns (`dsh/turns.ts`) through dsh's events. Each imports only dsh's
  types; the plugin's config gives it the dsh home, as `dshHomePath()` in
  the patch.
- **Two plugins, in the order they need each other.** dsh's session
  controller needs `ctx.fs`, the world's, which needs the runs. So the runs
  are a plugin of their own, which needs only the gateway, and the tau
  backend, which needs the session controller, comes last:

  ```
  gateway  ←  fleet-tau-runs  ←  fleet-fs, fleet-subprocess  ←  session controller
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
- A run has one result, the one its box packed when the run ended; what a
  person asks the run's session in the web UI later is not collected
  again, though tau's protocol lets a later result have the next number.
- A call whose connection is lost, as when dsh restarts, fails; the
  host's `tau finish` asks again when run again. While dsh is down, the
  tau service is not registered, so the `tau` command in a box, and the
  host's, find no service to reach, `NO_SERVICE`.
- A box left by a dsh that died while it set up a run stays. `fleet box
  list` shows it, its labels naming its session, and `fleet box rm`
  removes it.
- fleet's gateway must be running before dsh-tau loads: its client
  connects at once, and dsh-tau does not start the gateway.
- A call waiting for a lane shows nothing of it: its session looks as if
  its model were slow to answer.
- A run cannot name a model of its own: each tau's session starts on
  `fleet-tau-model`'s.
- The `tau` preset is in the web UI's list of presets, and its settings'
  default, since dsh has no hidden preset; a session given it fails each
  step.
- dsh-tau depends on dsh-base's row ids, `fs-sandbox`, `subprocess` and
  `spill-local`, whose modules its world mounts in their place; a profile
  that provides one of their services under another row has two providers
  of it.

## Built on

- fleet's gateway (docs/fleet/index.md), through `@sleepymug/fleet-sdk`
  (docs/fleet-sdk/index.md): `create`, `serviceList`, `serve` and
  `callerOf`, and of each `FleetBox`, `api`, `info`, `watch`, `start`,
  `stop`, `remove`, `put` and `get`,
  with `reasonOf`; the box API's `Spawn` and `Stat`;
  `@sleepymug/fleet-protocol`'s box API, failures and layout; and
  `@sleepymug/fleet-pack`'s trees, for what is put in a box and got from
  it.
- dsh's `domain/changed` (`@deepseek-ai/dsh-storage-domain`), for the
  archived sessions; `agent/pre-step`, `@deepseek-ai/dsh-llm`'s
  `createUserMessage` and `@deepseek-ai/dsh-session-projection`, for the
  notice.
- `@deepseek-ai/dsh-llm`'s `llm/stream` waterfall, which every model call
  goes through, for the lanes.
- `@sleepymug/tau`: the backend SDK, `@sleepymug/tau/backend` (`admit`,
  `place`, `expand`, `initDecision`); the core's `checkOutputs` and
  `checkReport`; `wire-tar`'s `decodeCall`, `unpackCall`, `decodeResult`
  and `packResult`; `transfer`'s `extractContent`; the rpc adaptor's
  `runsRoutes`, `Runs` and `descriptors`, `@sleepymug/tau/rpc`; and tau's
  package itself, the tau service's.
- `@connectrpc/connect`, for the service's failures, and
  `@bufbuild/protobuf`, for the box API's requests.
- dsh's session controller, workspace registry and agents
  (`@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-workspace`,
  `@deepseek-ai/dsh-agent`), and `@deepseek-ai/dsh-permission-presets`,
  for a session's full access.
- dsh's `agent/request` (`@deepseek-ai/dsh-agent`),
  `system-prompt/assemble` (`@deepseek-ai/dsh-system-prompt`), a session's
  request header (`@deepseek-ai/dsh-session`) and the session controller's
  `modelSelection` projection for the model a session starts on, and
  `@deepseek-ai/schemastery` for its volatile config.
- `@deepseek-ai/dsh-agent-preset`, `dsh-agent-tool-presentation`,
  `dsh-bash-local`, `dsh-tool-bash`, `dsh-tool-fs`, `dsh-skill-filesystem`
  and `dsh-tool-skill` for the `tau` preset, and `@deepseek-ai/dsh-tools`
  for hiding the host's tools.

## How it runs

fleet's gateway runs on its own, `fleet serve` (docs/fleet/cli/index.md).
dsh's `web` profile lists dsh-tau after dsh's base and web bundles, in
`$DSH_HOME/profiles/web/package.json`:

```json
{
  "dependencies": { "@sleepymug/dsh-tau": "link:<checkout>/packages/dsh-tau" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@sleepymug/dsh-tau"] } }
}
```

`pnpm exec dsh plugin --profile web add link:<checkout>/packages/dsh-tau`
makes it so, the profile made from dsh's web template if it was not
there. The web UI's sessions stay as dsh has them, with `tau_run` added.
docs/install.md installs it all from npm instead.

After `pnpm build` and `pnpm image`, with `fleet serve` running,
`pnpm exec dsh web`, with the dsh the workspace pins, starts the backend
with the web host, and the host's `tau --adaptor rpc` talks to it through
the gateway, at `/services/tau` on its clients' socket, as tau's config
file says (docs/install.md). On dsh's stderr:

```
dsh-tau: created session-4a65… in box-1c2d…, with the prompt:
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
dsh-tau: started session-4a65… in /home/me/notes, and gave it its prompt
dsh-tau: session-4a65… ended
dsh-tau: released session-4a65…, and removed its box box-1c2d…
```
