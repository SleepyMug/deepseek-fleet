# dsh-tau

The tau backend on dsh: its dsh bundle runs each run of a tau as a dsh
session in a box of its own, which fleet's gateway keeps
(docs/fleet/index.md). It has the tau backend and the runs of taus with
their boxes (docs/dsh-tau/tau/index.md), the tau service it serves
through the gateway, whose package, tau, puts the `tau` command in every
box; the world that serves a tau's session from its box
(docs/dsh-tau/world/index.md); `tau_run` (docs/dsh-tau/tools/index.md);
and the web client's tau model and tau lanes pages
(docs/dsh-tau/client/index.md). Nothing of dsh-tau's runs in a box: it
lays out a run's box, and gets back what the run gave, from the host,
through the box API. This page is how its parts are put together; each
part's page is what it does.

dsh-tau is one of the gateway's clients, and the fleet server of one of
its services: it knows boxes by the gateway's ids and labels, and the
gateway knows nothing of dsh or of tau.

## Design

- **Parts are given what they use.** A class takes what it builds on in
  its constructor, as one object of named dependencies, such as
  `new TauRuns({ registry, fleet, platform })`, and reaches nothing else:
  no other service of dsh's context, and nothing of the process but
  through its `Platform`. A test gives each its own.
- **Each is given an interface.** A part is typed by what it uses of
  another, not by its class: the runs of taus are, on dsh's context, the
  backend's `RunLifecycle` and the world's `TauBoxes` (`tau/ports.ts`); the
  backend reaches dsh's sessions through its `Sessions`; and the runs
  reach fleet's gateway through its `FleetPort`, its boxes as
  fleet-sdk's `FleetBox` is (`tau/fleet.ts` gives one of the client's).
  A test gives a fake of it, such as `tau/fake-fleet.test.util.ts`, whose
  boxes are folders, each serving the box API in the test's own process,
  or a gateway in the test's own process, its boxes Docker's.
- **The platform** (`platform.ts`) is what the runs and the backend take
  of the process: `log`, where they say what they do, `now`, `newId` and
  `after`, a timer that keeps nothing alive. `systemPlatform()` is the
  process's own, which logs on dsh's stderr after `dsh-tau:`, since dsh's
  logger shows no info.
- **dsh is reached at the edges.** The tau backend and the runs (`tau/`)
  import nothing of dsh's, but cordis's `Context`, in the plugins that put
  them together. What speaks dsh is in its own folders: `dsh/`, the
  adapters that give the backend dsh's sessions, archive and agents'
  turns; `world/`, the file system, subprocess runtime and spill store
  dsh's sessions work through; `preset/`, the plugins of the `tau` agent
  preset, its system prompt, its box's reset notice and its model;
  `tools/`, `tau_run`; and `client/`, the web client's pages, which run in
  the browser and reach dsh, and nothing of dsh-tau's host half, through
  the web client's services.
- **The gateway is reached through its client.** `fleet-tau-runs`
  connects one client, `ctx.fleet`, on the gateway's clients' socket,
  which every watch of a run's box, and the tau service's tunnel, are held
  on; the client makes its connection again when the gateway loses it, and
  takes them back (docs/fleet-sdk/index.md).
- **The plugins put the parts together.** Each dsh plugin checks its
  config, builds its parts on the services it injects, and provides them;
  `services.ts` declares every service dsh-tau provides on dsh's context,
  `ctx.fleet`, `ctx.fleetTauRuns`, `ctx.fleetTauModel` and
  `ctx.fleetTau`, which a plugin that uses one declares with
  `import type {} from '@sleepymug/dsh-tau/services'`. Their names, and
  the rows' ids, `fleet-tau-runs`, `fleet-tau`, `fleet-fs` and the others,
  are older than the package's name, which a profile's patch names them
  by.
- **One dsh home.** A plugin's config names the dsh home, and `paths.ts`
  gives every place in it: dsh-tau's own folder, `tau/`; the registry of
  the runs, `tau/runs/`; and dsh's attachment store, `attachments/`.
- **Shared helpers** are in `util/`: `Queue` and `KeyedQueue`, which run
  operations one after another, for each key, such as a session;
  `abortable`, which stops waiting for a promise when a signal aborts;
  `messageOf`, what a thrown value says; `spool`, bytes
  written to a file as they are read; and `streamOf` and `Pushed`, a
  call's requests as a stream, known at once or pushed while the call
  lasts. A test's platform is
  `manualPlatform()` (`platform.test.util.ts`), whose time moves, and
  timers run, as the test advances it.

## Provides

Beside each part's own modules:

- `@sleepymug/dsh-tau/services`, the services' declarations;
- `@sleepymug/dsh-tau/paths`, `tauPaths(dshHome, plugin)`, the places in
  a dsh home, which fails, naming the plugin, for a home that is not an
  absolute path.

## Built on

- fleet's gateway, `fleet serve`, which must be running (docs/fleet/index.md),
  through `@sleepymug/fleet-sdk`, the box API's and the gateway API's
  types, `@sleepymug/fleet-protocol`, and fleet-pack's trees,
  `@sleepymug/fleet-pack`.
- `@sleepymug/tau`, for the backend SDK, the rpc adaptor's service,
  `tau.v1.Runs`, and tau's client, which `tau_run` runs taus with; and
  tau's package itself, the tau service's, for the `tau` command in the
  boxes.
- `@connectrpc/connect` and `@bufbuild/protobuf`, for the box API's calls
  and the tau service's.
