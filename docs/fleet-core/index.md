# fleet-core

fleet's dsh bundle: the tau service and the runs of taus with their boxes
(docs/fleet-core/tau/index.md), the extensions they link
(docs/fleet-core/ext/index.md), the world that serves a tau's session from
its box (docs/fleet-core/world/index.md), `tau_run`
(docs/fleet-core/tools/index.md), Docker boxes
(docs/fleet-core/box/index.md), and the web client's tau model page
(docs/fleet-core/client/index.md). This page is how its parts are put
together; each part's page is what it does.

## Design

- **Parts are given what they use.** A class takes what it builds on in
  its constructor, as one object of named dependencies, such as
  `new TauRuns({ registry, exts, platform, boxes })`, and reaches nothing
  else: no other service of dsh's context, and nothing of the process but
  through its `Platform`. A test gives each its own.
- **Each is given an interface.** A part is typed by what it uses of
  another, not by its class: the runs of taus are, on dsh's context, the
  service's `RunLifecycle` and the world's `TauBoxes` (`tau/ports.ts`), and
  the service reaches dsh's sessions through its `Sessions`. A test gives a
  fake of it.
- **The platform** (`platform.ts`) is what the runs and the service take
  of the process: `log`, where they say what they do, `now`, `newId` and
  `after`, a timer that keeps nothing alive. `systemPlatform()` is the
  process's own, which logs on dsh's stderr after `fleet-tau:`, since dsh's
  logger shows no info.
- **dsh is reached at the edges.** The tau service, the runs and the
  boxes (`tau/`, `box/`, `ext/`) import nothing of dsh's, but cordis's
  `Context`, in the plugins that put them together. What
  speaks dsh is in its own folders: `dsh/`, the adapters that give the tau
  service dsh's sessions, archive and agents' turns; `world/`, the file
  system, subprocess runtime and spill store dsh's sessions work through;
  `preset/`, the plugins of the `tau` agent preset, its system prompt,
  its box's reset notice and its model; `tools/`, `tau_run`; and
  `client/`, the web client's page, which runs in the browser and reaches
  dsh, and nothing of fleet-core's host half, through the web client's
  services.
- **The plugins put the parts together.** Each dsh plugin checks its
  config, builds its parts on the services it injects, and provides them;
  `services.ts` declares every service fleet-core provides on dsh's
  context, `ctx.fleetExts`, `ctx.fleetTauRuns`, `ctx.fleetTauModel` and
  `ctx.fleetTau`, which a plugin that uses one declares with
  `import type {} from '@sleepymug/fleet-core/services'`.
- **One dsh home.** A plugin's config names the dsh home, and `paths.ts`
  gives every place in it: the registry of the runs, `fleet/taus/`; the
  service's socket, `fleet/tau.sock`; fleet's own folder, `fleet/`, where
  an extension keeps what it keeps in a folder of its own; and dsh's
  attachment store, `attachments/`.
- **Shared helpers** are in `util/`: `Queue` and `KeyedQueue`, which run
  operations one after another, for each key, such as a session;
  `abortable`, which stops waiting for a promise when a signal aborts;
  `messageOf`, what a thrown value says; and `spool`, bytes written to a
  file as they are read. A test's platform is `manualPlatform()`
  (`platform.test.util.ts`), whose time moves, and timers run, as the test
  advances it.

## Provides

Beside each part's own modules:

- `@sleepymug/fleet-core/services`, the services' declarations;
- `@sleepymug/fleet-core/paths`, `fleetPaths(dshHome, plugin)`, the places
  in a dsh home, which fails, naming the plugin, for a home that is not an
  absolute path.
