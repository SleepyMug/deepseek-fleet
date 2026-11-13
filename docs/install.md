# Installing fleet

Fleet is two things that run side by side, and the commands that talk to
them:

- the gateway, `fleet serve`, which keeps the boxes, Docker containers
  each with fleet's helper, and the services that plug into them
  (docs/fleet/index.md), with the box image it builds from what is
  installed;
- dsh-tau, a dsh bundle in a profile with dsh's web app, such as dsh's
  own `web` profile, whose sessions stay as dsh has them: the tau backend,
  each run of a tau a dsh session in a box of the gateway's, served as the
  gateway's tau service (docs/dsh-tau/index.md);
- tau's command, `tau`, whose rpc adaptor runs taus on dsh-tau's backend,
  through the gateway, and `fleet`, the gateway's own command.

Each package is published as `@sleepymug/<name>`, all but fleet-trace,
which runs on a checkout only (docs/fleet-trace/index.md).

## From npm

On linux, with Docker and pnpm on the PATH:

1. dsh, at the version dsh-tau names as its peer, which dsh does not
   check:

   ```
   npm install --global @deepseek-ai/dsh@0.2.1-rc.4
   ```

   With pnpm, `pnpm add --global @deepseek-ai/dsh@0.2.1-rc.4`, then
   `pnpm approve-builds --global` for dsh's native dependencies.

2. The gateway, with its `fleet` command, and tau's command, `tau`;
   and, if wanted, the example service, fleet-notes, whose `notes` command
   every box then has (docs/fleet-notes/index.md):

   ```
   npm install --global @sleepymug/fleet @sleepymug/tau @sleepymug/fleet-notes
   ```

   With pnpm, `pnpm approve-builds --global` for node-pty, which the box's
   helper runs terminals with.

3. The box image, from what step 2 installed
   (docs/fleet-box/image/index.md). Build it again after each update of
   the gateway:

   ```
   fleet image build
   ```

4. The gateway, which must be running whenever dsh-tau is: in a
   terminal, or as a systemd user unit, its home `~/.fleet` unless
   `$FLEET_HOME` names another (docs/fleet/cli/index.md); and, beside it,
   each service, such as fleet-notes:

   ```
   fleet serve
   fleet-notes
   ```

5. dsh-tau, which dsh makes the `web` profile for from its template if it
   has none yet:

   ```
   dsh plugin --profile web add @sleepymug/dsh-tau
   ```

   Optionally, dsh-tau's opinionated default, one basic agent preset with no
   multi-agent tools, so sessions run taus instead (docs/dsh-tau-basic/index.md):

   ```
   dsh plugin --profile web add @sleepymug/dsh-tau-basic
   ```

   A profile of its own works the same, made from dsh's web template
   first: `dsh --profile <name> --from-default-profile web --dump-config >
   /dev/null`.

6. tau's config file, `~/.config/tau/config.yaml` (tau's
   docs/spec/client.md#the-config-file), so that `tau` runs taus on
   dsh-tau's backend, through the gateway: the tau service, at
   `/services/tau` on the gateway's clients' socket, `fleet.sock` in the
   fleet home:

   ```yaml
   adaptor: rpc
   adaptors:
     rpc: { socket: ~/.fleet/fleet.sock, path: /services/tau }
   ```

7. Signing in to a model provider from a terminal, if wanted, is a profile
   of its own (docs/dsh-pi-signin/index.md):

   ```
   dsh plugin --profile pi-signin add @sleepymug/dsh-pi-signin
   dsh pi-signin
   ```

Then, with `fleet serve` running, `dsh web` starts dsh with the web UI and
the tau backend, and `tau run <tau-dir> --call <call.json>` runs a tau,
as tau's config file says, or with `--adaptor rpc`, `$TAU_RPC_SOCKET` and
`$TAU_RPC_PATH`. Each session the web UI makes has `tau_run`, which runs
one too, where its sandbox lets it write (docs/dsh-tau/tools/index.md); and
in each tau's box, the `tau` command, of the tau dsh-tau is installed with,
runs one, as the box's run's.

dsh-tau finds the gateway on its clients' socket, `$FLEET_SOCKET`, or
`fleet.sock` in the fleet home; a profile names another, and the image of
a run's box, with a row of its own for `fleet-tau-runs` in its
`cordis.patch.yml`, `~/.dsh/profiles/web/cordis.patch.yml` for the `web`
profile, which replaces the row's whole config, so it states the dsh home
too (docs/dsh-tau/tau/index.md):

```yaml
- id: fleet-tau-runs
  config:
    dshHome: !!js dshHomePath()
    fleetSocket: /home/me/.fleet/fleet.sock
    image: fleet:local
    idleStopMs: 60000
```

A tau's session starts on dsh's default model, which the web UI's model
picker sets, as any session does, unless the profile names one for every
tau's session: on the web UI's Plugins page, dsh-tau's "Tau model"
(docs/dsh-tau/client/index.md), or in its `cordis.patch.yml`
(docs/dsh-tau/tau/index.md). Either way, a session's model can be
switched in its chat box, as any session's:

```yaml
- id: fleet-tau-model
  config: { provider: openai-codex, model: gpt-6-astra, reasoningEffort: high }
```

A tau that relies on a service's command, such as `notes`, says so in its
prompt, and runs only where the gateway has the service registered
(tau's docs/spec/running.md).

- The image holds the packages as installed on the host, and so does
  each service's package as the gateway copies it into a box, so the host
  must be linux, on the architecture of Docker's server; and each box
  mounts a folder of the host's, `gateway/` in the fleet home, the
  gateway's boxes' socket, which its helper dials (docs/fleet/index.md),
  so Docker's server must be the host's own, not a remote one or Docker
  Desktop's VM.
- dsh's sandbox, which confines the sessions the web UI makes, needs
  bubblewrap or Landlock on linux (dsh's sandbox-local).

## From a checkout

tau is a submodule, `tau/`, at the commit this checkout builds on; the
workspace takes in its library, with its `tau` command (pnpm-workspace.yaml).
dsh is one installed globally, as above, or the workspace's own, which it
pins, run as `pnpm exec dsh` in place of `dsh`.

1. Clone with the submodule, or fetch it in a clone made without:

   ```
   git clone --recursive git@github.com:SleepyMug/deepseek-fleet.git
   git submodule update --init
   ```

2. Install at the root only, since an install inside `tau/` installs it
   on its own until the next one at the root. `pnpm image` builds the
   workspace, tau first, then the box image, `fleet:local`, or the tag it
   is given, as `pnpm image fleet:next`; `pnpm build` the workspace alone.
   Build the image again after each change to fleet-box:

   ```
   pnpm install
   pnpm image
   ```

3. Link the checkout's dsh-tau into a profile, from the checkout's root:

   ```
   dsh plugin --profile web add ./packages/dsh-tau
   ```

   Optionally after it, `./packages/dsh-tau-basic` (docs/dsh-tau-basic/index.md).
   dsh then loads the checkout's latest build each time it starts. A
   linked package loads the dsh packages it declares as peers from the
   installed dsh, and keeps the workspace's, its dev dependencies, for its
   builds and tests (dsh's docs/user/develop/basic/publish.md).

4. Link the `tau`, `fleet` and `fleet-notes` commands, which follow the
   checkout's builds, and have `tau` run on dsh-tau's backend, through the
   gateway, by default:

   ```
   pnpm add --global "link:$PWD/tau" "link:$PWD/packages/fleet" "link:$PWD/services/notes"
   mkdir -p ~/.config/tau && printf 'adaptor: rpc\nadaptors:\n  rpc: { socket: ~/.fleet/fleet.sock, path: /services/tau }\n' > ~/.config/tau/config.yaml
   ```

5. Run the gateway, the notes service, and dsh, each in a terminal of
   its own:

   ```
   fleet serve
   fleet-notes
   dsh web
   ```

A change to tau is a commit in `tau/`, pushed to its own repository, and
then a commit here with the submodule at it, so each commit here names the
tau it builds on. `git submodule update --remote tau` moves it to tau's
`main`.
