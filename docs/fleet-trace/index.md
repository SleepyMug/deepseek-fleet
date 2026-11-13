# fleet-trace

Shows what fleet's models are sent. `fleet-trace` runs a tau, or a session
given a prompt, as the web UI makes one, against a scripted model on a
scratch gateway and dsh with dsh-tau, and dumps every request dsh makes
of the model: the system prompt, the tools, and the conversation, each call and
each result as sent. It is for working on the prompt and the tools, not a
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
| `conversation.md` | The rest of that request's messages: the user's, each tool call with its arguments, a command, which may carry a program, or what a call writes, in a block of its own, and each result as sent, with a JSON result also indented. |
| `result.json` | How the run ended; for a session, `{ sessionId, end, text }`: why its last turn ended, as dsh logs it, and its agent's last text. |
| `work/` | The caller's folder after the run or the session, with what the runs gave back at its paths. |
| `dsh.log` | What dsh wrote. |
| `fleet.log` | What the gateway and the notes service wrote. |

A run whose tau's init does it, without the model, has no requests, and so
only `result.json`, `work/`, `dsh.log` and `fleet.log`.

A scenario is JSON, its paths relative to its file, such as
`packages/fleet-trace/scenarios/notebook.json`:

```json
{
  "tau": "../../../examples/notebook",
  "files": { "list.txt": "buy milk #shop\n" },
  "call": { "files": { "list": "list.txt", "report": "out/report.txt" }, "args": { "tag": "shop" } },
  "steps": [{ "tool": "bash", "args": { "command": "notes --help" } }],
  "final": "Done."
}
```

- `tau`: the tau's directory.
- `prompt`: in place of `tau` and `call`, what a person tells a session
  that the web UI makes, in the caller's folder; its model works on the
  host. `scenarios/tau-run.json` has it run a tau of the caller's folder,
  with `tau_run`.
- `files`: the caller's folder, each file by its path, with its text.
- `call`: the run's call, its `files` and `args`, as `tau start` takes
  them.
- `steps`: the model's tool calls, one per turn, in order.
- `final`: the model's answer after the last step.
- `runs`: what the model does in the runs the run starts, with the `tau`
  command in its box, or the session, with `tau_run`, each `{ match, steps,
  final }`, for the run whose prompt holds the phrase `match`.
  `scenarios/relay.json` runs `examples/relay`, whose agent runs the tau it
  holds, `taus/shout`, with `tau run`, which writes the report.
  `scenarios/best-of.json` runs `examples/best-of`, given a shout tau of the
  caller's folder and the report as extra files, and a call to make, which
  its program, reading the call from the run's context, makes twice at
  once with `tau run`, each run with an `out` of its own, and keeps one;
  the call's `$${out}` reaches each shout as its own place.
  `scenarios/notebook.json` runs `examples/notebook`, whose agent saves its
  list with the notes service's `notes` command, and reports a tag's notes.

`scenarios/glossary.json` runs `examples/glossary`, whose init defines a
term its glossary has without the model; `scenarios/glossary-broken.json`
gives it a glossary that is not JSON, so its init fails, and the agent,
told so after the prompt, defines the term.

## Design

- **A scratch gateway.** Each run makes a fleet home in a temporary
  folder, and runs this checkout's `fleet serve` on it
  (docs/fleet/cli/index.md), its boxes on the image `$FLEET_TRACE_IMAGE`,
  or the gateway's own, `fleet:local`, so build first: `pnpm build` and
  `pnpm image`; and, once the gateway listens, this checkout's notes service,
  `fleet-notes` (docs/fleet-notes/index.md), registered there, its
  notebooks in the fleet home. What they write is `fleet.log`.
- **A scratch dsh.** Each run makes a dsh home in the same folder, whose
  profile, `fleet`, links this checkout's dsh-tau, after dsh's base and web
  bundles, as dsh's `web` profile has them, mounts fleet-trace's driver,
  and routes the model to the scripted one; dsh's own `plugin install`
  installs it. It runs the workspace's dsh, on a free port, with
  `$FLEET_SOCKET` naming the scratch gateway's socket, so dsh-tau's boxes are
  the scratch gateway's, and its tau service registers there.
- **The run** is started and finished through the tau backend's socket, as
  `tau start --adaptor socket` and `tau finish` do it, with tau's client
  and its socket adaptor, which pack the call and put the result at the
  caller's paths, the scripted model told the run's prompt by the
  backend's `list`, with the caller's folder made from `files`, and the
  folder of each file's path in `call`, where an `out` goes.
- **A session** is made through the driver (`driver.ts`), a dsh plugin of
  this package on a socket in the scratch home, as the web UI makes one: in
  the dsh workspace of the caller's folder, with the profile's default
  agent preset, dsh's `standard`, given the prompt; its model works on the
  host, in dsh's sandbox, `workspace-write`. The driver answers once the
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
  result and the caller's folder are kept, and every run is released, with
  its box; a run that failed says why on stderr. dsh is stopped, its whole
  process group; every box the scratch gateway still has is removed, whatever
  a run left; the notes service and the gateway are stopped; and the
  temporary folder removed. A run that stops when dsh exits says so, with its log. An
  interrupted one, by Ctrl-C or SIGTERM, cleans up the same way before it
  exits.

## Built on

- tau's client and its socket adaptor, `createSocketAdaptor` and
  `socketTransport`, and `@sleepymug/dsh-tau-box/runs`, for the tau
  backend and its own `list`.
- `@sleepymug/fleet-sdk`, for the boxes left at the end.
- The checkout's `fleet` and `fleet-notes`, run on this Node.
- dsh's workspace registry, session controller and agents, for the
  driver, whose types it writes out, so it imports nothing of dsh's.
- The workspace's dsh, through `pnpm exec dsh`.
