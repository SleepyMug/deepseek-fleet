# fleet-box/helper

The helper is fleet's process inside a box. It does what the fleet host
asks, from inside the container: it serves the box's files and runs its
processes and terminals, which the host's clients ask of the box
(docs/fleet/index.md), as dsh-tau's world does for a tau's session
(docs/dsh-tau/world/index.md); and it keeps the box's services: their
commands on the PATH, their environment, and their sockets, whose
connections it carries to the host over the box's channel, which the host
passes on to each service's gateway (docs/fleet/services/index.md).

## Provides

- `@sleepymug/fleet-protocol/helper`: the wire between the host and the
  helper, shared by both ends (docs/fleet-protocol/index.md). It holds
  `PROTOCOL_VERSION`, the message types, and `Methods`, which gives each
  method's params, result and events; and `@sleepymug/fleet-protocol/channel`,
  the box's channel's (docs/fleet-protocol/index.md).
- `lib/helper/main.js`: the helper itself. It runs only in the image, at the
  path `@sleepymug/fleet-protocol/layout` gives, and is not exported. It
  serves the host (`serve.ts`) on its stdin and stdout, in the box's
  environment and working folder.
- `@sleepymug/fleet-box/helper/serve`: `serve({ input, output, env, cwd, log, layout? })`,
  which puts a helper together from what it is given, for a host that runs
  one outside a box, as a test does, its services' folders under `layout`.

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
ends, it ends the processes and terminals it started, its watches and the
services' connections, answers what is left, and exits.

| Method | Params | Result | |
|---|---|---|---|
| `hello` | `{}` | `{ protocol, methods }` | The handshake: the wire version, and every method the helper serves. The host refuses another protocol version, and a helper that lacks a method the host uses, or lists none: its box was made from an older image. |
| `echo` | `{ text }` | `{ text }` | A trivial directive. |
| `exec` | `{ argv }` | `{ code, signal, stdout, stderr }` | Run a program, as the container's root, without a shell, in the helper's environment, the box's services' with it. An exit other than 0, or a signal, is a result; a program that cannot run is an error. |
| `fs.resolve`, `fs.stat`, `fs.lstat`, `fs.readText`, `fs.readBytes`, `fs.readRange`, `fs.listDir`, `fs.writeText`, `fs.editText` | as dsh's `FileSystem` methods take them | as they answer; bytes in base64 | The box's files, served by dsh's own local file system (`cmd/fs.ts`). A target is the local one's: its key is the canonical path in the box. |
| `fs.watch` | `{ watch, target }` | `null` | Watch a target, under the host's id `watch`, with dsh's local file system: an event, `{ error }`, each time it may have changed, the error that ended the watching if one did. It answers once `fs.unwatch` ends it. |
| `fs.unwatch` | `{ watch }` | `null` | End a watch; nothing for a watch not there. |
| `spawn` | `{ process, argv, cwd, env, stdin, graceMs }` | `{ code, signal }` | Run a program, without a shell, in a session of its own, under the host's id `process`, in the folder `cwd`, with `env` added to the helper's environment (`null` removes a name) and `stdin` as its input, or none. It sends what the program writes as events, `{ stream, data }`, the bytes in base64, and answers once the program has exited and its output has ended, or `graceMs` after its exit when something it started keeps the output open (`cmd/spawn.ts`). |
| `kill` | `{ process }` | `null` | End a process's group: SIGTERM, then SIGKILL after its `graceMs`. |
| `which` | `{ command, env }` | the program's path | Find a program: an absolute path that is an executable file, or a bare name on the `PATH` of `env`, or the helper's, the services' commands first. One not there fails with the code `EXECUTABLE_NOT_FOUND`. |
| `terminal` | `{ terminal, argv, cwd, env, cols, rows, term, graceMs }` | `{ code, signal }` | Run a program on a pseudo-terminal in the box, under the host's id `terminal`, in a session it leads, its environment as a process's (`cmd/terminal.ts`). It sends `{ kind: 'started', pid }`, then what the terminal writes, `{ kind: 'data', data }`, base64, and answers once the program has exited. |
| `terminal.write` | `{ terminal, data }` | `null` | Write text to the terminal's input. |
| `terminal.resize` | `{ terminal, cols, rows }` | `null` | Change its size, which its foreground program is told. |
| `terminal.foreground` | `{ terminal }` | `{ processGroupId }` or `null` | The terminal's foreground process group, as the kernel has it (`/proc/<pid>/stat`). |
| `terminal.activity` | `{ terminal }` | `{ idle }` | Whether the terminal is idle: no process of its session is left, or its program, the shell, is the session's only process, holds the foreground and sleeps, as at its prompt. A loop of the shell's builtins that sleeps looks the same. A terminal not there has ended, so it is idle. |
| `terminal.signal` | `{ terminal, signal }` | the group's id | Signal the foreground process group: `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGTSTP` or `SIGHUP`. |
| `terminal.end` | `{ terminal }` | `null` | End every process in the terminal's session, background jobs included: SIGHUP and SIGTERM, then SIGKILL after `graceMs`. It answers once none is left. |
| `services.installed` | `{}` | `{ <name>: [<digest>, …] }` | The services' packages the box holds, `/opt/fleet/services/<name>@<digest>`, by name (`cmd/services.ts`). |
| `services.sync` | `{ services: [{ name, digest, bins, env }] }` | `null` | Make the box's services these, each of whose packages it holds: `/opt/fleet/services/<name>` a link to the one in use; each command, by its name in `bins`, a link in `/opt/fleet/bin` to its program in the package, made executable; its environment added to the helper's, for every process it starts from then on; and its socket, `/run/fleet/services/<name>.sock`, listened on. A service not listed loses its link, commands, environment and socket, and keeps its package; an older package of one listed is removed. A package the box does not hold fails it. |

- **Process groups.** A spawned program and what it starts share a process
  group, except what starts a session of its own. `kill` and the helper's
  exit end the group; whatever escapes it ends when the box stops. A
  terminal's program leads a session, whose every process `terminal.end`,
  and the helper's exit, end.
- **Environments.** A process's environment, a terminal's, and `exec`'s, is
  the helper's, which is the box's, with the box's services' added
  (`cmd/env.ts`), then what the host gives it, a name given `null` removed;
  and, whatever the host gives, `/opt/fleet/bin`, the services' commands,
  first on its PATH, once, since a harness may pass a PATH of its own.
  `$FLEET_SERVICES` names `/run/fleet/services`, where the services'
  sockets are.
- **The services' sockets** (`cmd/services.ts`). Before it reads a request,
  the helper makes the services' folders and names them in its
  environment; `services.sync` then listens on each listed service's socket,
  which anyone in the box may open, since the box is its own. Each
  connection is a stream of the box's channel (fleet-protocol's channel):
  the helper makes one HTTP/2 connection to the channel's socket,
  `/run/fleet/host/channel.sock`, as the first program connects, and again
  once the host dropped it, as when it restarts; and sends each connection
  as a request, `POST /services/<name>`, its body what the program sends,
  the response's body what the host sends back, once the host answered
  `200`. HTTP/2's flow control paces each stream, a mebibyte its window, so
  a side that reads slowly slows the other, and the channel, sixteen. A
  program's end of what it sends is a half-close, and the host's end of
  what it sends ends the program's; a stream the host cuts, or refuses, is
  a connection cut in the box, and one the program cuts before its end is
  a stream cut. Which box a connection comes from is the host's to say, by
  the channel it comes in on, and whether the box may use the service, so
  the helper checks only that its service is listed. Without the services'
  folders, only the services fail.
- **A helper is what it is given.** `serve({ input, output, env, cwd, log })`
  puts one together: its processes (`cmd/spawn.ts`, `Processes`), its
  terminals (`cmd/terminal.ts`, `Terminals`), its files and watches
  (`cmd/fs.ts`, `Files`), and its services (`cmd/services.ts`, `Services`),
  each an object of its own, which keep what they started, and end it as
  the helper does; the environment every process starts from, which the
  services add to; and the folder relative paths are in. Nothing reads the
  process's own, but `main.ts`, so a test serves a helper in its own
  process, its services' folders elsewhere.
- **Back pressure.** While the host has not taken what the helper wrote,
  the helper stops reading every program's output, and goes on once the
  host catches up.

A new method needs three things:
- an entry in `Methods`, in fleet-protocol's `helper`;
- a handler in `serve.ts`, or, for a command beyond the handshake, in a
  module of its own in `helper/cmd/`, as `exec` has, or a method of one of
  its objects, which `serve.ts` registers;
- a check of its result, and of its events if it sends any, on the host,
  in fleet's `box/cmd/` beside what the host calls it with, which
  `box/helper.ts` registers.

## Built on

- Node: `readline` over stdin, JSON lines on stdout, `child_process` for
  `exec` and `spawn`, and `net` for the services' sockets.
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

Outside a box, `node packages/fleet-box/lib/helper/main.js` runs it on your
terminal, where you can type requests as JSON lines; it keeps no services
there, since it cannot make their folders, and says so on stderr.
