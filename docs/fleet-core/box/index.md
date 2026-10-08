# fleet-core/box

A box is one Docker container, with fleet's helper running in it while the
box is started. The container stays until it is removed, and keeps what is
in it through any number of starts and stops.

## Provides

`Box`, from `@sleepymug/fleet-core/box`:

| Verb | What it does | Using |
|---|---|---|
| `Box.create({ image?, name? })` | Create the container, stopped. | `docker create --init --pull never --label fleet.box … sleep infinity` |
| `Box.open(name)` | Take a box that exists already, running or not. | `docker container inspect`, which must show the label |
| `Box.list()` | List every box, with its state. | `docker container ls --all --filter label=fleet.box` |
| `box.start(onCall?)` | Start the container, then a new helper in it, and do the handshake. `onCall` answers the calls of the clients in the box while that helper runs; without it, each fails. | `docker start`, `docker exec --interactive` |
| `box.request(method, params, onEvent?)` | Send one method to the started box's helper; `onEvent` is told each event it sends before its result. | the helper connection |
| `box.stop()` | End the helper and stop the container. | `docker stop` |
| `box.copyIn(from, to)` | Copy a host file to a path in the box, or a host folder's contents into a folder in the box. | `docker cp <from> <container>:<to>`, or `<from>/.` for a folder |
| `box.copyOut(from, to)` | Copy a box folder's contents into a host folder. | `docker cp <container>:<from>/. <to>` |
| `box.pipe(argv, { input?, output? })` | Run a program in the started box, without a shell and outside the helper, `input` its stdin and its stdout written to `output`, for bytes the helper's lines of JSON would carry only as text; an exit other than 0 fails, with what it wrote to stderr. | `docker exec --interactive` |
| `box.remove()` | End the helper and remove the container, running or not. | `docker rm --force` |

It also exports:
- `exec(box, argv)`, which runs a program in a started box with the helper's
  `exec`, and gives back what it wrote to stdout; an exit other than 0 fails,
  with what it wrote to stderr;
- `HelperError`, a failure the helper reports for one request, with its `code`, if it has one;
- `CallHandler`, what answers a call: `(call, signal, body?) => Promise<JSON | Streamed>`,
  `body` the bytes after a call that has them, and a `Streamed`, made with
  `streamed(value, body)`, an answer with bytes after it (docs/fleet-core/ext/index.md);
- `METHODS`, the methods a helper takes;
- `BOX_LABEL`, the label that marks a box's container.

## Design

- **Fixed containers.** The image is used as built, and is never pulled
  (`--pull never`). `--init` puts an init process in front of `sleep`, so
  `docker stop` ends the container right away instead of waiting out its
  grace period.
- **One verb at a time.** A box runs its verbs in order; each waits for the
  one before it.
- **The helper connection** (`box/helper.ts`) runs a command, does the
  handshake, and matches answers, and the events before them, to requests by
  id. It refuses a method
  outside `METHODS` without sending it. Anything in the container can
  impersonate the helper, so it checks every message, every result and every
  event before using it: a file target, for one, must name an absolute
  path. A helper that breaks the protocol loses its connection.
- **Calls** from the box come over the same connection: the helper sends a
  `call`, which the connection hands to the box's `onCall`, with a signal
  that aborts when the helper cancels it or the connection ends, and sends
  back its result, or its failure's message. A result that is not JSON is a
  failure.
- **When the helper exits on its own,** every pending and later request
  fails. The container stays, and `start()` starts a new helper.
- **A box keeps the image it was made from,** so a rebuilt image reaches
  only boxes made after it. The handshake refuses a helper that lacks a
  method the host uses, or does not list its methods, and says so, rather
  than letting each method fail on its own; `start()` then leaves the
  container stopped.
- **Commands** of the helper's beyond the handshake have a module each in
  `box/cmd/`, beside their handler in fleet-box-runtime's `helper/cmd/`: the
  check of the command's result, which `box/helper.ts` registers, and what the
  host calls it with, such as `exec`.
- **Copies** work whether the box runs or not. A file goes to the path it is
  given, and a folder's contents into the folder it is given, which is made
  if it is missing. The parent must exist. A folder's copy merges into what
  is there already, and symlinks are copied as links. A whole copy, in or
  out, puts the file or folder itself at a path not there yet, keeping
  modes, and a symlink there as a link. Paths in the box are absolute.

## Built on

- The Docker CLI, through `execFile`.
- `@sleepymug/fleet-box-runtime/layout`, for where the helper is in the image.
- `@sleepymug/fleet-box-runtime/helper/protocol`, for the wire.

## How it runs

```ts
import { Box, exec } from '@sleepymug/fleet-core/box'

const box = await Box.create()             // image fleet:local, a fresh name
await box.copyIn('./input', '/data')
await box.start()
await box.request('echo', { text: 'hi' })  // { text: 'hi' }
await exec(box, ['ls', '/data'])           // what ls wrote
await box.stop()                           // stopped; /data is still there
await box.remove()
```
