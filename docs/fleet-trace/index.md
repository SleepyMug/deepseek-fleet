# fleet-trace

Shows what a tau's model is sent. `fleet-trace` runs a tau against a
scripted model on a scratch fleet host, and dumps every request dsh makes of
the model: the system prompt, the tools, and the conversation, each call and
each result as sent. It is for working on the prompt and the tools, not a
test of the model.

## Provides

`fleet-trace <scenario.json> [out]`, a bin of this package, which the
workspace's root lists, so `pnpm exec fleet-trace` runs it. It writes to
`out`, by default `/tmp/fleet-trace/<scenario's name>`, emptied first:

| File | What it holds |
|---|---|
| `requests/NNN.json` | Each request as the model got it, in order; `NNN-run.json` for the run's conversation, `NNN-child.json` for that of a run it started, the others, such as dsh's for a session title, without. |
| `system-prompt.md` | The last request of the run's system prompt, as it is. |
| `tools/<name>.json` | Each tool as the model gets it: name, description, parameters. |
| `conversation.md` | The rest of that request's messages: the user's, each tool call with its arguments, a program's source in a block of its own, and each result as sent, with a JSON result also indented. |
| `result.json` | How the run ended. |
| `work/` | The caller's folder after the run, with what the run gave back at its paths. |
| `dsh.log` | What dsh wrote. |

A scenario is JSON, its paths relative to its file, such as
`packages/fleet-trace/scenarios/notebook.json`:

```json
{
  "tau": "../../../examples/notebook",
  "files": { "list.txt": "buy milk #shop\n" },
  "values": { "list": { "$in": "list.txt" }, "tag": "shop", "report": { "$out": "out/report.txt" } },
  "steps": [{ "tool": "ts_modules", "args": {} }],
  "final": "Done."
}
```

- `tau`: the tau's directory.
- `files`: the caller's folder, each file by its path, with its text.
- `values`: the run's values, as `fleet start` sends them.
- `steps`: the model's tool calls, one per turn, in order.
- `final`: the model's answer after the last step.
- `runs`: what the model does in the runs the run starts, through the `tau`
  API, each `{ match, steps, final }`, for the run whose prompt holds the
  phrase `match`. `scenarios/relay.json` runs `examples/relay`, whose
  program runs the tau it holds, `taus/shout`, which writes the report.

## Design

- **A scratch host.** Each run makes a dsh home in a temporary folder,
  whose fleet profile links this checkout's fleet-core and every extension
  in `ext/`, after dsh's base and web bundles, and routes the model to the
  scripted one; dsh's own `plugin install` installs it. It runs the
  workspace's dsh, on a free port, and the image `fleet:local`, so build
  first: `pnpm build` and `pnpm image`.
- **The run** is started and finished through the tau service's socket, as
  `fleet run` does it, with fleet-client's `startRun` and `finishRun`, which
  pack the call and put the result at the caller's paths, with the caller's
  folder made from `files`, and the folders of the `$out` handles.
- **The scripted model** (`model.ts`) is an OpenAI-compatible endpoint on
  localhost. A request carrying the tau's prompt is the run's: it answers
  with the step after as many as the request has tool results for, and with
  `final` after the last. A request carrying one of `runs`' phrases is a
  started run's, answered the same way from its script. It answers any
  other request with a word. It
  holds every request until it knows the prompt, which `start` answers
  with, since dsh may ask before the answer comes.
- **The end.** Once the run has ended, as `finish` says, and what it gave
  back is put at the caller's paths, its result and the caller's folder are
  kept, and the session is deleted, with its box, and the runs it started;
  a run that failed says why on stderr. dsh is
  stopped, its whole process group, and the temporary folder
  removed. A run that stops when dsh exits says so, with its log. An
  interrupted one, by Ctrl-C or SIGTERM, cleans up the same way before it
  exits.

## Built on

- `fleet-client/connection`, `fleet-client/runs` and `fleet-protocol/tau`,
  for the tau service.
- The workspace's dsh, through `pnpm exec dsh`.
