# Installing fleet

Fleet is dsh bundles, in a dsh profile of their own, `fleet`; a box image,
built from what that profile installed; and `fleet`, a command of its own.
Each package is published as `@sleepymug/<name>`, all but fleet-trace,
which runs on a checkout only (docs/fleet-trace/index.md).

## From npm

On linux, with Docker and pnpm on the PATH:

1. dsh, at the version fleet's packages name as their peer, which dsh does
   not check:

   ```
   npm install --global @deepseek-ai/dsh@0.2.0-rc.2
   ```

2. The fleet profile, from dsh's web template, which lists dsh's base and
   web bundles; then fleet-core, after them; then each extension, after
   fleet-core:

   ```
   dsh --profile fleet --from-default-profile web --dump-config > /dev/null
   dsh plugin --profile fleet add @sleepymug/fleet-core
   dsh plugin --profile fleet add @sleepymug/fleet-ext-tau @sleepymug/fleet-ext-notes
   ```

3. The box image, built by the profile's own fleet-box-runtime, which the
   host runs in each box (docs/fleet-box-runtime/image/index.md). Listing
   it in the profile, beside fleet-core, gives the profile its command;
   it is no bundle, which dsh says once. Each package is published at the
   version of the others, so the two are one install:

   ```
   dsh plugin --profile fleet add @sleepymug/fleet-box-runtime
   dsh plugin --profile fleet exec fleet-box-image
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

Then `dsh fleet` starts the host, with the web UI, and `fleet run <tau-dir>`
runs a tau.

- The image holds the packages as installed on the host, so the host must
  be linux, on the architecture of Docker's server.

## From a checkout

`pnpm install`, `pnpm build` and `pnpm image` at the root, with tau's
checkout beside this one (pnpm-workspace.yaml). The workspace pins dsh,
run as `pnpm exec dsh`; each package's "How it runs" links its checkout
into the profile, as `pnpm exec dsh plugin --profile fleet add
link:<checkout>/packages/fleet-core`, and runs `fleet` as
`node <checkout>/packages/fleet-client/lib/cli.js`.
