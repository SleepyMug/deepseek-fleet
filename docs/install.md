# Installing fleet

Fleet is dsh bundles, installed in a dsh profile with dsh's web app, such
as dsh's own `web` profile, whose sessions stay as dsh has them; a box
image, built from what that profile installed; and `fleet`, a command of
its own. Each package is published as `@sleepymug/<name>`, all but
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

4. `fleet`, which talks to the profile's service and loads no dsh module
   (docs/fleet-client/index.md):

   ```
   npm install --global @sleepymug/fleet-client
   ```

5. Signing in to a model provider from a terminal, if wanted, is a profile
   of its own (docs/fleet-signin/index.md):

   ```
   dsh plugin --profile fleet-signin add @sleepymug/fleet-signin
   dsh fleet-signin
   ```

Then `dsh web` starts the host, with the web UI, and `fleet run <tau-dir>`
runs a tau. Each session the web UI makes has `tau_run`, which runs one
too, where its sandbox lets it write (docs/fleet-core/tools/index.md).

Each extension implements a contract of tau's, which it depends on, such as
`@sleepymug/tau-api-notes`, so a tau that holds a copy of it runs. Making a
tau that does takes tau's own command, `tau add` (tau's
docs/spec/development.md):

```
npm install --global @sleepymug/tau-dev
cd <tau-dir>; tau add notes @sleepymug/tau-api-notes
```

- The image holds the packages as installed on the host, so the host must
  be linux, on the architecture of Docker's server.
- dsh's sandbox, which confines the sessions the web UI makes, needs
  bubblewrap or Landlock on linux (dsh's sandbox-local).

## From a checkout

`pnpm install`, `pnpm build` and `pnpm image` at the root, with tau's
checkout beside this one, its library, its `tau` command and its contracts
joining the workspace (pnpm-workspace.yaml). The workspace pins dsh,
run as `pnpm exec dsh`; each package's "How it runs" links its checkout
into the profile, as `pnpm exec dsh plugin --profile web add
link:<checkout>/packages/fleet-core`, and runs `fleet` as
`node <checkout>/packages/fleet-client/lib/cli.js`.
