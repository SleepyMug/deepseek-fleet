# fleet/box

A box is one Docker container, with fleet's helper running in it while the
box is started. The container stays until it is removed, and keeps what is
in it through any number of starts and stops. The fleet host keeps each box
as a `Box` (docs/fleet/index.md); this is the container and its helper alone.

## Provides

`Box`, from `@sleepymug/fleet/box`:

| Verb | What it does | Using |
|---|---|---|
| `Box.create({ image?, name?, env?, labels? })` | Create the container, stopped, with `env` the environment of every process in it, and `labels` beside its own. | `docker create --init --pull never --label fleet.box … sleep infinity` |
| `Box.open(name)` | Take a box that exists already, running or not. | `docker container inspect`, which must show the label |
| `Box.list()` | List every box, with its state. | `docker container ls --all --filter label=fleet.box` |
| `box.start(onConnection?)` | Start the container, then a new helper in it, and do the handshake. `onConnection` takes each connection a program in the box opens to a service's socket while that helper runs; without it, each is cut. | `docker start`, `docker exec --interactive` |
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
- `ConnectionHandler`, what takes a relayed connection:
  `(service, connection) => void`, `connection` a `Duplex` stream (below);
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
  id. It refuses a method outside `METHODS` without sending it. Anything in
  the container can impersonate the helper, so it checks every message,
  every result and every event before using it: a file target, for one, must
  name an absolute path. A helper that breaks the protocol loses its
  connection.
- **Relayed connections** come over the same connection: the helper says a
  program in the box opened one to a service's socket there, which the
  connection hands to `onConnection` as a `Duplex` stream, under the
  service's name. What the stream reads is what the program sent, and what
  is written to it reaches the program; its end, either way, is a
  half-close, and destroying it cuts the connection on both sides. Neither
  side has more than `CONNECTION_WINDOW`, a mebibyte, of the other's bytes
  that it has not acknowledged: a write waits while the box is behind, and
  the bytes the stream has not had read yet are acknowledged only as they
  are read, so a side that reads slowly slows the other. A helper that
  opens a connection under an id in use loses its connection; one that ends,
  ends its connections too.
- **When the helper exits on its own,** every pending and later request
  fails, and its connections are cut. The container stays, and `start()`
  starts a new helper.
- **A box keeps the image it was made from,** so a rebuilt image reaches
  only boxes made after it. The handshake refuses a helper that lacks a
  method the host uses, or does not list its methods, and says so, rather
  than letting each method fail on its own; `start()` then leaves the
  container stopped.
- **Commands** of the helper's beyond the handshake have a module each in
  `box/cmd/`, beside their handler in fleet-box's `helper/cmd/`: the check
  of the command's result, which `box/helper.ts` registers, and what the host
  calls it with, such as `exec`.
- **Copies** work whether the box runs or not. A file goes to the path it is
  given, and a folder's contents into the folder it is given, which is made
  if it is missing. The parent must exist. A folder's copy merges into what
  is there already, and symlinks are copied as links. A whole copy, in or
  out, puts the file or folder itself at a path not there yet, keeping
  modes, and a symlink there as a link. Paths in the box are absolute.

## Built on

- The Docker CLI, through `execFile`.
- `@sleepymug/fleet-protocol/layout`, for where the helper is in the image,
  and `@sleepymug/fleet-protocol/helper`, for the wire.

## How it runs

```ts
import { Box, exec } from '@sleepymug/fleet/box'

const box = await Box.create({ name: 'demo', labels: { 'fleet.label.who': 'me' } })   // image fleet:local
await box.copyIn('./input', '/data')
await box.start()
await box.request('echo', { text: 'hi' })  // { text: 'hi' }
await exec(box, ['ls', '/data'])           // what ls wrote
await box.stop()                           // stopped; /data is still there
await box.remove()
```
