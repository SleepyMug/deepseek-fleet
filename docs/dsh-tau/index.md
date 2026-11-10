# dsh-tau

The tau backend on dsh: its dsh bundle runs each run of a tau as a dsh
session in a box of its own, which the fleet host keeps
(docs/fleet/index.md). It has the tau backend and the runs of taus with
their boxes (docs/dsh-tau/tau/index.md), the tau service it registers with
the fleet host, which puts the `tau` command in every box; the world that
serves a tau's session from its box (docs/dsh-tau/world/index.md);
`tau_run` (docs/dsh-tau/tools/index.md); and the web client's tau model
and tau lanes pages (docs/dsh-tau/client/index.md). What it puts in each
box is a package of its own, dsh-tau-box (docs/dsh-tau-box/index.md). This
page is how its parts are put together; each part's page is what it does.

dsh-tau is one of the fleet host's clients, and one of its services: it
knows boxes by the host's ids and labels, and the host knows nothing of
dsh or of tau.

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
  reach the fleet host through its `FleetPort`, its boxes as
  fleet-client's `FleetBox` is (`tau/fleet.ts` gives one of the client's).
  A test gives a fake of it, such as `tau/fake-fleet.test.util.ts`, whose
  boxes are folders, or a fleet host in the test's own process, its boxes
  Docker's.
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
- **The fleet host is reached through its client.** `fleet-tau-runs`
  connects one client, `ctx.fleetClient`, on the host's socket, which
  every lease of a run's box, and the tau service, are held on; the
  client makes its connection again when the host loses it, and takes them
  back (docs/fleet-client/index.md).
- **The plugins put the parts together.** Each dsh plugin checks its
  config, builds its parts on the services it injects, and provides them;
  `services.ts` declares every service dsh-tau provides on dsh's context,
  `ctx.fleetClient`, `ctx.fleetTauRuns`, `ctx.fleetTauModel` and
  `ctx.fleetTau`, which a plugin that uses one declares with
  `import type {} from '@sleepymug/dsh-tau/services'`. Their names, and
  the rows' ids, `fleet-tau-runs`, `fleet-tau`, `fleet-fs` and the others,
  are older than the package's name, which a profile's patch names them
  by.
- **One dsh home.** A plugin's config names the dsh home, and `paths.ts`
  gives every place in it: dsh-tau's own folder, `tau/`; the registry of
  the runs, `tau/runs/`; the backend's socket, `tau/tau.sock`; and dsh's
  attachment store, `attachments/`.
- **Shared helpers** are in `util/`: `Queue` and `KeyedQueue`, which run
  operations one after another, for each key, such as a session;
  `abortable`, which stops waiting for a promise when a signal aborts;
  `messageOf`, what a thrown value says, and `codeOf`, a failure's code,
  such as the fleet host's `BOX_GONE` or an `FsError`'s; and `spool`, bytes
  written to a file as they are read. A test's platform is
  `manualPlatform()` (`platform.test.util.ts`), whose time moves, and
  timers run, as the test advances it.

## Provides

Beside each part's own modules:

- `@sleepymug/dsh-tau/services`, the services' declarations;
- `@sleepymug/dsh-tau/paths`, `tauPaths(dshHome, plugin)`, the places in
  a dsh home, which fails, naming the plugin, for a home that is not an
  absolute path.

## Built on

- The fleet host, `fleet serve`, which must be running (docs/fleet/index.md),
  through `@sleepymug/fleet-client` and the wire's types,
  `@sleepymug/fleet-protocol`.
- dsh-tau-box (docs/dsh-tau-box/index.md), for what goes in the boxes.
- `@sleepymug/tau`, for the backend SDK, the socket adaptor's transports,
  and tau's client, which `tau_run` runs taus with.
