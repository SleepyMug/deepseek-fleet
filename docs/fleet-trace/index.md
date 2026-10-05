# fleet-trace

Shows what fleet's models are sent. `fleet-trace` runs a tau, or a session
given a prompt, as the web UI makes one, against a scripted model on a
scratch fleet host, and dumps every request dsh makes of the model: the
system prompt, the tools, and the conversation, each call and each result as
sent. It is for working on the prompt and the tools, not a
test of the model.

## Provides

`fleet-trace <scenario.json> [out]`, a bin of this package, which the
workspace's root lists, so `pnpm exec fleet-trace` runs it. It writes to
`out`, by default `/tmp/fleet-trace/<scenario's name>`, emptied first:

| File | What it holds |
|---|---|
| `requests/NNN.json` | Each request as the model got it, in order; `NNN-run.json` for the scenario's conversation, the run's or the session's, `NNN-child.json` for that of a run it started, the others, such as dsh's for a session title, without. |
| `system-prompt.md` | The last request of the scenario's conversation's system prompt, as it is. |
| `tools/<name>.json` | Each tool as the model gets it: name, description, parameters. |
| `conversation.md` | The rest of that request's messages: the user's, each tool call with its arguments, a program's source in a block of its own, and each result as sent, with a JSON result also indented. |
| `result.json` | How the run ended; for a session, `{ sessionId, end, text }`: why its last turn ended, as dsh logs it, and its agent's last text. |
| `work/` | The caller's folder after the run or the session, with what the runs gave back at its paths. |
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
- `prompt`: in place of `tau` and `values`, what a person tells a session
  that the web UI makes, in the caller's folder; its model works on the
  host. `scenarios/tau-run.json` has it run a tau of the caller's folder,
  with `tau_run`.
- `files`: the caller's folder, each file by its path, with its text.
- `values`: the run's values, as `fleet start` sends them.
- `steps`: the model's tool calls, one per turn, in order.
- `final`: the model's answer after the last step.
- `runs`: what the model does in the runs the run starts, through the `tau`
  API, or the session, with `tau_run`, each `{ match, steps, final }`, for
  the run whose prompt holds the phrase `match`. `scenarios/relay.json` runs `examples/relay`, whose
  program runs the tau it holds, `taus/shout`, which writes the report.

## Design

- **A scratch host.** Each run makes a dsh home in a temporary folder,
  whose fleet profile links this checkout's fleet-core and every extension
  in `ext/`, after dsh's base and web bundles, mounts fleet-trace's driver,
  and routes the model to the scripted one; dsh's own `plugin install`
  installs it. It runs the
  workspace's dsh, on a free port, and the image `fleet:local`, so build
  first: `pnpm build` and `pnpm image`.
- **The run** is started and finished through the tau service's socket, as
  `fleet run` does it, with fleet-client's `startRun` and `finishRun`, which
  pack the call and put the result at the caller's paths, with the caller's
  folder made from `files`, and the folders of the `$out` handles.
- **A session** is made through the driver (`driver.ts`), a dsh plugin of
  this package on a socket in the scratch home, as the web UI makes one: in
  the dsh workspace of the caller's folder, with the profile's default
  agent preset, `fleet`, given the prompt. The driver answers once the
  session's agent is done, with how its last turn went.
- **The scripted model** (`model.ts`) is an OpenAI-compatible endpoint on
  localhost. A request with tools carrying the prompt, the tau's or the
  session's, is the scenario's conversation: it answers with the step after
  as many as the request has tool results for, and with `final` after the
  last. A request with tools carrying one of `runs`' phrases is a started
  run's, answered the same way from its script. It answers any other
  request with a word, such as dsh's for a session's title, which quotes
  what a person said. It holds every request until it knows the prompt,
  which a run's `start` answers with, since dsh may ask before the answer
  comes.
- **The end.** Once the run has ended, as `finish` says, and what it gave
  back is put at the caller's paths, or the session's agent is done, the
  result and the caller's folder are kept, and every run is deleted, with
  its box; a run that failed says why on stderr. dsh is
  stopped, its whole process group, and the temporary folder
  removed. A run that stops when dsh exits says so, with its log. An
  interrupted one, by Ctrl-C or SIGTERM, cleans up the same way before it
  exits.

## Built on

- `fleet-client/connection`, `fleet-client/runs` and `fleet-protocol/tau`,
  for the tau service.
- dsh's workspace registry, session controller and agents, for the
  driver, whose types it writes out, so it imports nothing of dsh's.
- The workspace's dsh, through `pnpm exec dsh`.
