# fleet-image/helper

The helper is fleet's process inside a box. It does what the host asks,
from inside the container: it serves the box's files and runs its
processes, for fleet-core's `ctx.fs` and `ctx.subprocess`
(docs/fleet-core/world/index.md).

## Provides

- `fleet-image/helper/protocol`: the wire between the host and the helper,
  shared by both ends. It holds `PROTOCOL_VERSION`, the message types, and
  `Methods`, which gives each method's params, result and events.
- `lib/helper/main.js`: the helper itself. It runs only in the image, at the
  path `fleet-image/layout` gives, and is not exported.

## Design

One JSON message per line over the helper's stdin and stdout:

- host to helper: `{ "type": "request", "id": 1, "method": "echo", "params": { "text": "hi" } }`
- helper to host:
  - `{ "type": "result", "id": 1, "value": { "text": "hi" } }`;
  - `{ "type": "error", "id": 1, "message": "…", "code": "…" }`, with the
    code of the failure, such as an `FsError`'s, if it has one;
  - `{ "type": "event", "id": 1, "value": … }`, any number of them before
    the request's result, for a method that sends events.

The helper answers every request exactly once, in any order. When its stdin
ends, it ends the processes and terminals it started and its watches,
answers what is left, and exits.

| Method | Params | Result | |
|---|---|---|---|
| `hello` | `{}` | `{ protocol, methods }` | The handshake: the wire version, and every method the helper serves. The host refuses another protocol version, and a helper that lacks a method the host uses, or lists none: its box was made from an older image. |
| `echo` | `{ text }` | `{ text }` | A trivial directive. |
| `exec` | `{ argv }` | `{ code, signal, stdout, stderr }` | Run a program, as the container's root, without a shell. An exit other than 0, or a signal, is a result; a program that cannot run is an error. |
| `fs.resolve`, `fs.stat`, `fs.lstat`, `fs.readText`, `fs.readBytes`, `fs.readRange`, `fs.listDir`, `fs.writeText`, `fs.editText` | as dsh's `FileSystem` methods take them | as they answer; bytes in base64 | dsh's file system, served by dsh's own local one (`cmd/fs.ts`). A target is the local one's: its key is the canonical path in the box. |
| `fs.watch` | `{ watch, target }` | `null` | Watch a target, under the host's id `watch`, with dsh's local file system: an event, `{ error }`, each time it may have changed, the error that ended the watching if one did. It answers once `fs.unwatch` ends it. |
| `fs.unwatch` | `{ watch }` | `null` | End a watch; nothing for a watch not there. |
| `spawn` | `{ process, argv, cwd, env, stdin, graceMs }` | `{ code, signal }` | Run a program, without a shell, in a session of its own, under the host's id `process`, in the folder `cwd`, with `env` added to the helper's environment (`null` removes a name) and `stdin` as its input, or none. It sends what the program writes as events, `{ stream, data }`, the bytes in base64, and answers once the program has exited and its output has ended, or `graceMs` after its exit when something it started keeps the output open (`cmd/spawn.ts`). |
| `kill` | `{ process }` | `null` | End a process's group: SIGTERM, then SIGKILL after its `graceMs`. |
| `which` | `{ command, env }` | the program's path | Find a program: an absolute path that is an executable file, or a bare name on the `PATH` of `env`, or the helper's. One not there fails with the code `EXECUTABLE_NOT_FOUND`. |
| `terminal` | `{ terminal, argv, cwd, env, cols, rows, term, graceMs }` | `{ code, signal }` | Run a program on a pseudo-terminal in the box, under the host's id `terminal`, in a session it leads (`cmd/terminal.ts`). It sends `{ kind: 'started', pid }`, then what the terminal writes, `{ kind: 'data', data }`, base64, and answers once the program has exited. |
| `terminal.write` | `{ terminal, data }` | `null` | Write text to the terminal's input. |
| `terminal.resize` | `{ terminal, cols, rows }` | `null` | Change its size, which its foreground program is told. |
| `terminal.foreground` | `{ terminal }` | `{ processGroupId }` or `null` | The terminal's foreground process group, as the kernel has it (`/proc/<pid>/stat`). |
| `terminal.signal` | `{ terminal, signal }` | the group's id | Signal the foreground process group: `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGTSTP` or `SIGHUP`. |
| `terminal.end` | `{ terminal }` | `null` | End every process in the terminal's session, background jobs included: SIGHUP and SIGTERM, then SIGKILL after `graceMs`. It answers once none is left. |

- **Process groups.** A spawned program and what it starts share a process
  group, except what starts a session of its own. `kill` and the helper's
  exit end the group; whatever escapes it ends when the box stops. A
  terminal's program leads a session, whose every process `terminal.end`,
  and the helper's exit, end.
- **Back pressure.** While the host has not taken what the helper wrote,
  the helper stops reading every program's output, and goes on once the
  host catches up.

A new method needs three things:
- an entry in `Methods`;
- a handler in `main.ts`, or, for a command beyond the handshake, in a
  module of its own in `helper/cmd/`, as `exec` has, which `main.ts`
  registers;
- a check of its result, and of its events if it sends any, on the host,
  in fleet-core's `box/cmd/` beside what the host calls it with, which
  `box/helper.ts` registers.

## Built on

- Node: `readline` over stdin, JSON lines on stdout, and `child_process`
  for `exec` and `spawn`.
- `@deepseek-ai/dsh-fs-local`, dsh's local file system, mounted in a cordis
  context of the helper's own (`@deepseek-ai/cordis`), for the `fs.*`
  methods.
- `node-pty`, for terminals, loaded when the first one starts, so a box
  without it fails only terminals.

The image has these as installed on the host, so the host's Node and the
image's must be the same version, as they are (26.9.0), for node-pty's
native build.

## How it runs

The host starts one helper per started box with
`docker exec --interactive <container> /usr/local/bin/node /opt/fleet/lib/helper/main.js`.
The helper runs until the host ends its stdin.

Outside a box, `node packages/fleet-image/lib/helper/main.js` runs it on
your terminal, where you can type requests as JSON lines.
