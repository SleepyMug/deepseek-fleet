# fleet-profile

The fleet profile's layer over dsh's base and web bundles: a config-only
bundle, with no code. It sets the profile up for agents that run unattended.

## Provides

A bundle patch, `cordis.patch.yml`, which the fleet profile lists after
`@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`:

| What | How |
|---|---|
| No sandbox | The sandbox, its executors and the Permissions selector are off; `bash-local` and `fs-local` give unconfined bash and file tools, and the sandbox policy says `danger-full-access`. |
| Nothing waits on a person | Approval answers every request at once (`never`), and `ask_user` is off. |
| One agent preset, `fleet` | The default, and the only one, with no preset picker: a persona, bash in the foreground only, read/write/edit, and compaction. |

## Design

- **The model is the profile's.** Which model runs, and its context window,
  is set in the profile's own `cordis.patch.yml`, which dsh applies after
  every bundle; a model route signs in with fleet-signin
  (docs/fleet-signin/index.md).
- **Bash in the foreground.** Nothing a command starts outlives its call, so
  an idle agent has finished its work. A command past its timeout is killed
  rather than moved to the background.
- **Swapping a row.** A patch's `name` only asserts an existing row's
  module, so the sandbox's executors are disabled and the local ones inserted
  under ids of their own.

## Built on

dsh's own plugins: `dsh-bash-local`, `dsh-fs-local`, `dsh-agent-preset`,
`dsh-persona`, `dsh-tool-bash`, `dsh-tool-fs` and dsh's compaction.

## How it runs

Add it to the fleet profile once, from the checkout:

```
pnpm exec dsh plugin --profile fleet add link:<checkout>/packages/fleet-profile
```

which links it and appends it to the profile's bundles in
`$DSH_HOME/profiles/fleet/package.json`:

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "fleet-core", "fleet-profile"]
```

fleet-profile and fleet-core change rows of their own, so their order does
not matter. Then `pnpm exec dsh --profile fleet`.
