# fleet-basic

fleet's opinionated default for a profile's own sessions, the ones the
web UI makes: one agent preset, `basic`, a coding agent as simple as pi's,
and dsh's other presets off. Its sessions have no subagents, teams, todo,
plan mode, goals or background jobs, so work they would hand to other
agents goes to taus, with fleet-core's `tau_run`
(docs/fleet-core/tools/index.md). It is a config-only dsh bundle,
`cordis.patch.yml`, with no code.

## Install

After fleet-core, in the same profile:

```
dsh plugin --profile web add @sleepymug/fleet-basic
```

or, from a checkout, `./packages/fleet-basic`.

## What it sets

- `preset-standard`, `preset-ptc`, `preset-minimal` and `preset-cordis`,
  dsh-base's presets, off. fleet-core's `tau` preset stays, for the runs'
  sessions.
- `agent-preset-registry`: new sessions get `basic`.
- `preset-basic`, the `basic` preset: a persona naming the model and the
  working directory; the project's AGENTS.md; `bash`, foreground only;
  `read`, `write`, `edit` and `read_image`; `glob` and `grep`;
  `web_search` and `web_fetch`; `skill`, which loads tau's primers, the
  skills `tau` and `tau-dev`, that `tau_run`'s prompt points to; and
  compaction, `/compact` and old tool-result pruning. `tau_run` comes
  from fleet-core, as for every session.

The profile's own `cordis.patch.yml`, which dsh's settings write, comes
after every bundle, so what a person sets there wins; an entry there for
one of these rows replaces the row's whole config.
