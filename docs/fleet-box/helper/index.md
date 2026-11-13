# fleet-box/helper

The helper is fleet's process in a box, each box's command. It dials the
gateway (docs/fleet/index.md) on the socket the box mounts, opens a tunnel
naming its box, and serves the box's API over it, which the gateway carries
to it from its clients; and it serves the box's services to the box's
programs, on one socket, carrying their calls to the gateway on a
connection of its own. It ends what it started as the box stops.

## Provides

- `@sleepymug/fleet-box/helper`: `startHelper({ gateway, box, layout?, env?,
  log? })`, a helper put together from what it is given, which settles once
  its tunnel first opens, and gives back what closes it; for a gateway that
  runs one outside a box, as fleet's local driver and a test do, its layout
  rooted elsewhere.
- `lib/helper/main.js`, the helper's process, the box's command: the
  gateway's socket in `$FLEET_GATEWAY`, the box's id in `$FLEET_BOX`, and,
  outside a container, a root in `$FLEET_BOX_ROOT`.

What it serves over its tunnel, fleet.box.v1 (fleet-protocol's box):

| Method | What it does |
|---|---|
| `Box.Exec` | Run a program to its end, without a shell, and answer how it ended, its exit code or the signal that ended it, and all it wrote. A program that cannot run is an error. |
| `Box.Spawn`, both ways a stream | Run a program in a process group of its own: the first request what to run, those after it its input, its input's end, or a signal for its group; the responses its pid, what it writes, and, last, how it ended, once it exited and its output ended, or its grace period after the exit. Cancelling the call ends its group, SIGTERM, then SIGKILL after the grace period. |
| `Box.Which` | Where a program is: an absolute path that is an executable file, or a bare name on the box's PATH, the services' commands first; empty when it is not there. |
| `Box.Terminal`, both ways a stream | Run a program on a pseudo-terminal, in a session it leads, through node-pty: the requests what to run, what is typed, the terminal's size, a signal for its foreground group, or its status, which a response answers, whether it is idle and its foreground group; the responses its pid, what it writes, and, last, how its program ended. Every process left in its session ends with the call. |
| `Box.Stat`, `ListDir`, `ReadFile`, `WriteFile`, `MakeDir`, `Remove`, `Rename` | The box's files, every path absolute: what is at a path, nothing if nothing is, with its version, a token that changes whenever it does; a folder's entries; a file's bytes, or a range, as a stream; a file written from a stream, made with its folders if asked, exclusive or appended, one replaced written beside it and put in its place whole, through its symlinks, keeping its permission bits, and, given a version, only if the file is still at it, else aborted; folders made; things removed and moved. A failure's code is its errno's: not found, already there, permission denied, and so on. |
| `Box.Resolve`, `Box.Watch` | Where a path leads, every symlink followed, a `..` after one taken from where it leads, or, for a path to nothing, its nearest folder that is there and the rest; and a watch of a file or a folder, ready first, then each change, until the call is cancelled, a file watched through its folder so that one replaced stays watched. |
| `Box.Put`, `Box.Get` | Trees: a tar archive unpacked into a folder, through the box's own symlinks, what is there and not in it kept; a folder's contents, or a file under its own name, as one. |
| `Provision.Installed`, `Provision.Install` | The digest of the tree the box holds at `/fleet`, and a tree installed in place of it, each of its places, `README.md`, `bin`, `services` and `node_modules`, replaced, and whatever else is in `/fleet`, as the box's programs, kept. The gateway alone asks them. |

## Design

- **It dials; nothing dials it.** The tunnel is a WebSocket at the gateway's
  `/fleet/tunnel`, saying the box's id and the helper's protocol, after
  which the gateway calls the helper over it (docs/fleet-net/index.md).
  The helper opens it again whenever it closes, after a pause, a tenth of a
  second at first, up to two seconds, as when the gateway restarts, so a box
  outlives its gateway.
- **The services' socket** (`relay.ts`), `/run/fleet/services.sock`, takes
  HTTP/2 and HTTP/1.1 alike, anyone in the box may open it, and each call
  to `/services/<name>/` on it is carried to the gateway's boxes' socket,
  saying the box's id, a program's own `fleet-` headers dropped; whether
  the box may call the service is the gateway's to say. Anything else is
  refused.
- **Environments** (`box/env.ts`). Every program starts from the box's
  environment, its services' and its creator's, as the container has it,
  less the helper's own, `$FLEET_GATEWAY` and `$FLEET_BOX_ROOT`; with
  `/fleet/bin` first on its PATH, once, whatever a call gives, and
  `$FLEET_SERVICES_SOCKET`; then what the call adds, less what it removes.
- **Process groups.** A spawned program and what it starts share a process
  group, but what starts a session of its own; the call's end and the
  helper's end end it. A terminal's program leads a session, whose every
  process the call's end ends: SIGHUP and SIGTERM, then SIGKILL.
- **Back pressure.** A program's output is read only as fast as the call
  takes it: once enough waits, its streams pause until the caller catches
  up, as HTTP/2's flow control paces the call.
- **A helper is what it is given**: its processes (`box/processes.ts`), its
  terminals (`box/terminal.ts`), its files (`box/files.ts`), its tree
  (`provision.ts`) and its services' socket (`relay.ts`), so a test serves
  one in its own process, its layout under a folder of its own.

## Built on

- `@sleepymug/fleet-protocol`, for the API and the layout; fleet-net, for
  the tunnel, the socket and the carrying of calls; fleet-pack, for trees.
- `@connectrpc/connect-node`, which serves the API.
- `node-pty`, for terminals, loaded as the first one starts, so a box
  without it fails only terminals.

The image has these as installed on the host, so the host's Node and the
image's must be the same version, as they are (26.9.0), for node-pty's
native build.

## How it runs

The gateway's Docker driver makes each box's container run
`/usr/local/bin/node /opt/fleet/lib/helper/main.js`, an init first, which
passes on the SIGTERM of `docker stop`, and the helper runs until the box
stops.
