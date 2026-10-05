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
| `requests/NNN.json` | Each request as the model got it, in order; `NNN-run.json` for the run's conversation, the others, such as dsh's for a session title, without. |
| `system-prompt.md` | The last request of the run's system prompt, as it is. |
| `tools/<name>.json` | Each tool as the model gets it: name, description, parameters. |
| `conversation.md` | The rest of that request's messages: the user's, each tool call with its arguments, a program's source in a block of its own, and each result as sent, with a JSON result also indented. |
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
- `values`: the run's values, as `fleet create` sends them.
- `steps`: the model's tool calls, one per turn, in order.
- `final`: the model's answer after the last step.

## Design

- **A scratch host.** Each run makes a dsh home in a temporary folder,
  whose fleet profile links this checkout's fleet-core and every extension
  in `ext/`, after dsh's base and web bundles, and routes the model to the
  scripted one; dsh's own `plugin install` installs it. It runs the
  workspace's dsh, on a free port, and the image `fleet:local`, so build
  first: `pnpm build` and `pnpm image`.
- **The run** is created and started through the tau service's socket, as
  `fleet` does it, with the caller's folder made from `files`, and the
  folders of the `$out` handles.
- **The scripted model** (`model.ts`) is an OpenAI-compatible endpoint on
  localhost. A request carrying the tau's prompt is the run's: it answers
  with the step after as many as the request has tool results for, and with
  `final` after the last. It answers any other request with a word.
- **The end.** Once the run has had `final`, the session is deleted, with
  its box, dsh is stopped, its whole process group, and the temporary folder
  removed. A run that stops when dsh exits says so, with its log. An
  interrupted one, by Ctrl-C or SIGTERM, cleans up the same way before it
  exits.

## Built on

- `fleet-client/connection` and `fleet-protocol/tau`, for the tau service.
- The workspace's dsh, through `pnpm exec dsh`.
