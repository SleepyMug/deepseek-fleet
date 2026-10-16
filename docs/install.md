# Installing fleet

Fleet is dsh bundles in a dsh profile with dsh's web app, such as dsh's
own `web` profile, whose sessions stay as dsh has them; a box image built
from what that profile installed; tau's command, `tau`, whose fleet
adaptor runs taus on the profile's service; and `fleet`, a command of its
own. Each package is published as `@sleepymug/<name>`, all but
fleet-trace, which runs on a checkout only (docs/fleet-trace/index.md).

## From npm

On linux, with Docker and pnpm on the PATH:

1. dsh, at the version fleet's packages name as their peer, which dsh does
   not check:

   ```
   npm install --global @deepseek-ai/dsh@0.2.0-rc.2
   ```

   With pnpm, `pnpm add --global @deepseek-ai/dsh@0.2.0-rc.2`, then
   `pnpm approve-builds --global` for dsh's native dependencies.

2. fleet-core, with fleet-box-runtime, whose command builds the image;
   then each extension, after fleet-core. dsh makes the `web` profile from
   its template if it has none yet:

   ```
   dsh plugin --profile web add @sleepymug/fleet-core @sleepymug/fleet-box-runtime
   dsh plugin --profile web add @sleepymug/fleet-ext-tau @sleepymug/fleet-ext-notes
   ```

   dsh says once that fleet-box-runtime is no bundle.

   A profile of its own works the same, made from dsh's web template
   first: `dsh --profile <name> --from-default-profile web --dump-config >
   /dev/null`.

3. The box image, from what the profile installed, with the packages it
   leaves to dsh from the install of the `dsh` on the PATH
   (docs/fleet-box-runtime/image/index.md). Build it again after each
   update of the profile or of dsh:

   ```
   dsh plugin --profile web exec fleet-box-image
   ```

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
or with `adaptor: fleet` in tau's config file, `~/.config/tau/config.yaml`
(tau's docs/spec/client.md), runs a tau. Each session the web UI makes has `tau_run`, which runs one
too, where its sandbox lets it write (docs/fleet-core/tools/index.md).

A tau's session starts on dsh's default model, which the web UI's model
picker sets, as any session does, unless the profile names one for every
tau's session: on the web UI's Plugins page, fleet-core's "Tau model"
(docs/fleet-core/client/index.md), or in its `cordis.patch.yml`,
`~/.dsh/profiles/web/cordis.patch.yml` for the `web` profile
(docs/fleet-core/tau/index.md). Either way, a session's model can be
switched in its chat box, as any session's:

```yaml
- id: fleet-tau-model
  config: { provider: openai-codex, model: gpt-6-astra, reasoningEffort: high }
```

A tau that uses an extension's API holds a copy of its contract, the
package the extension depends on, such as `@sleepymug/tau-api-notes` for
fleet-ext-notes, as published, in `api/<alias>/` (tau's
docs/spec/apis.md):

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
(pnpm-workspace.yaml). dsh is one installed globally, as above, or the
workspace's own, which it pins, run as `pnpm exec dsh` in place of `dsh`.

1. Clone with the submodule, or fetch it in a clone made without:

   ```
   git clone --recursive git@github.com:SleepyMug/deepseek-fleet.git
   git submodule update --init
   ```

2. Install at the root only, since an install inside `tau/` installs it
   on its own until the next one at the root. `pnpm image` builds the
   workspace, tau first, then the box image; `pnpm build` the workspace
   alone. Build the image again after each change to fleet-box-runtime:

   ```
   pnpm install
   pnpm image
   ```

3. Link the checkout's bundles into a profile, fleet-core first, from the
   checkout's root:

   ```
   dsh plugin --profile web add ./packages/fleet-core ./ext/fleet-ext-tau ./ext/fleet-ext-notes
   ```

   dsh then loads the checkout's latest build each time it starts. A
   linked package loads the dsh packages it declares as peers from the
   installed dsh, and keeps the workspace's, its dev dependencies, for its
   builds and tests (dsh's docs/user/develop/basic/publish.md).

4. Link the `tau` and `fleet` commands, which follow the checkout's builds,
   and have `tau` run on fleet by default:

   ```
   pnpm add --global "link:$PWD/tau" "link:$PWD/packages/fleet-client"
   mkdir -p ~/.config/tau && echo 'adaptor: fleet' > ~/.config/tau/config.yaml
   ```

   The socket is `~/.dsh/fleet/tau.sock` unless the file names another:
   `adaptors: { fleet: { socket: <path> } }`.

5. Run the host:

   ```
   dsh web
   ```

A change to tau is a commit in `tau/`, pushed to its own repository, and
then a commit here with the submodule at it, so each commit here names the
tau it builds on. `git submodule update --remote tau` moves it to tau's
`main`.
