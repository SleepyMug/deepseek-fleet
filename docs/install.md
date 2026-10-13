# Installing fleet

Fleet is dsh bundles, installed in a dsh profile with dsh's web app, such
as dsh's own `web` profile, whose sessions stay as dsh has them; a box
image, built from what that profile installed; tau's command, `tau`,
whose fleet adaptor runs taus on the profile's service; and `fleet`, a
command of its own. Each package is published as `@sleepymug/<name>`, all but
fleet-trace, which runs on a checkout only (docs/fleet-trace/index.md).

## From npm

On linux, with Docker and pnpm on the PATH:

1. dsh, at the version fleet's packages name as their peer, which dsh does
   not check:

   ```
   npm install --global @deepseek-ai/dsh@0.2.0-rc.2
   ```

2. fleet-core, after dsh's base and web bundles, which `web` lists; then
   each extension, after fleet-core. dsh makes the `web` profile from its
   template if it has none yet:

   ```
   dsh plugin --profile web add @sleepymug/fleet-core
   dsh plugin --profile web add @sleepymug/fleet-ext-tau @sleepymug/fleet-ext-notes
   ```

   A profile of its own works the same, made from dsh's web template
   first: `dsh --profile <name> --from-default-profile web --dump-config >
   /dev/null`.

3. The box image, built by the profile's own fleet-box-runtime, which the
   host runs in each box (docs/fleet-box-runtime/image/index.md). Listing
   it in the profile, beside fleet-core, gives the profile its command;
   it is no bundle, which dsh says once. Each package is published at the
   version of the others, so the two are one install:

   ```
   dsh plugin --profile web add @sleepymug/fleet-box-runtime
   dsh plugin --profile web exec fleet-box-image
   ```

   Build it again after each update of the profile.

4. tau's command, `tau`, which runs taus through its fleet adaptor on the
   profile's service (tau's docs/spec/fleet.md), and `fleet`, which shows
   the runs there; neither loads a dsh module (docs/fleet-client/index.md):

   ```
   npm install --global @sleepymug/tau @sleepymug/fleet-client
   ```

5. Signing in to a model provider from a terminal, if wanted, is a profile
   of its own (docs/fleet-signin/index.md):

   ```
   dsh plugin --profile fleet-signin add @sleepymug/fleet-signin
   dsh fleet-signin
   ```

Then `dsh web` starts the host, with the web UI, and `tau run --adaptor
fleet <tau-dir> --call <call.json>`, or `tau run` with `TAU_ADAPTOR=fleet`,
runs a tau. Each session the web UI makes has `tau_run`, which runs one
too, where its sandbox lets it write (docs/fleet-core/tools/index.md).

Each extension implements a contract, which it depends on, such as
`@sleepymug/tau-api-notes`, published beside fleet-ext-notes, so a tau that
holds a copy of it runs. A tau holds a copy of a contract as its package
is published, its `package.json` and its declarations, in `api/<alias>/`
(tau's docs/spec/apis.md):

```
mkdir -p <tau-dir>/api/notes
npm pack @sleepymug/tau-api-notes && tar -xzf sleepymug-tau-api-notes-*.tgz --strip-components=1 -C <tau-dir>/api/notes
```

- The image holds the packages as installed on the host, so the host must
  be linux, on the architecture of Docker's server.
- dsh's sandbox, which confines the sessions the web UI makes, needs
  bubblewrap or Landlock on linux (dsh's sandbox-local).

## From a checkout

tau is a submodule, `tau/`, at the commit this checkout builds on; the
workspace takes in its library, with its `tau` command, and its contracts
(pnpm-workspace.yaml). The workspace pins dsh, run as `pnpm exec dsh`.

1. Clone with the submodule, or fetch it in a clone made without:

   ```
   git clone --recursive git@github.com:SleepyMug/deepseek-fleet.git
   git submodule update --init
   ```

2. Install at the root only: `pnpm install` inside `tau/` installs it on
   its own again, from its own lockfile, and the next install at the root
   switches it back. Then build tau, fleet, and the box image:

   ```
   pnpm install
   (cd tau && pnpm build)
   pnpm build
   pnpm image
   ```

   Build the image again after each change to fleet-box-runtime.

3. Link the checkout's bundles into a profile, fleet-core first:

   ```
   pnpm exec dsh plugin --profile web add link:$PWD/packages/fleet-core
   pnpm exec dsh plugin --profile web add link:$PWD/ext/fleet-ext-tau link:$PWD/ext/fleet-ext-notes
   ```

4. Run the host, and the commands from the checkout:

   ```
   pnpm exec dsh web
   alias tau="node $PWD/tau/dist/cli/main.js"
   alias fleet="node $PWD/packages/fleet-client/lib/cli.js"
   ```

A change to tau is a commit in `tau/`, pushed to its own repository, and
then a commit here with the submodule at it, so each commit here names the
tau it builds on. `git submodule update --remote tau` moves it to tau's
`main`.
