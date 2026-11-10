# fleet

The fleet host, `@sleepymug/fleet`: a service of its own, `fleet serve`,
that keeps boxes, each a Docker container with fleet's helper in it while it
runs (docs/fleet/box/index.md), for as long as their creators want them,
and stops each once nothing has used it for a while; and that takes
services, each a gateway on the host that plugs in, whose means of calling
it, a node package of commands, it puts in the boxes
(docs/fleet/services/index.md). Its clients, a harness such as dsh's
dsh-tau, or a service, reach it on its socket, through fleet-client
(docs/fleet-client/index.md), and ask a box's files, processes and terminals
of its helper through it. It knows nothing of tau or dsh: a box is its id,
its labels, and what is in it.

## Provides

- `fleet` (docs/fleet/cli/index.md), the command: `fleet serve` runs the
  host; the others are its clients.
- `@sleepymug/fleet/host`: `FleetHost`, the host, with the `Registry` of its
  boxes and `systemPlatform`, for a host in a process of its own choosing,
  as a test runs one.
- `@sleepymug/fleet/server`: `listen(socket, host)`, which serves a host on
  its socket, and `serve(connection, host)`, one client's connection.
- `@sleepymug/fleet/box`: `Box`, one container (docs/fleet/box/index.md).

The host's **home** is `$FLEET_HOME`, or `~/.fleet`:

| Place | What it holds |
|---|---|
| `fleet.sock` | The socket, unless `$FLEET_SOCKET` names another. |
| `boxes/<id>.json` | Each box the host made, as it made it: its id, image, labels, environment, services, idle time, and when (`registry.ts`). |
| `services/<name>@<digest>` | Each service's package, as the host staged it (docs/fleet/services/index.md). |
| `channels/<id>/channel.sock` | Each box's channel, the socket its helper reaches the host's services on, the folder mounted in the box (below). |

What its clients ask, the ops of its wire, each answered once, with events
before the answer for an op that sends them; the wire itself is
docs/fleet-protocol/index.md:

| Op | What it does |
|---|---|
| `box.create { image?, labels?, env?, services?, idleStopMs? }` | Make a box, stopped, and answer what it is, `BoxInfo`. |
| `box.list { labels? }` | Every box, oldest first, or those whose labels hold each of `labels`. |
| `box.get { box }` | One box, with its state. |
| `box.start { box }` | Start a box, without occupying it: it stops once it has been idle long enough. |
| `box.stop { box }` | Stop a box, whatever occupies it. |
| `box.stopWhenVacant { box }` | Stop a box at once if nothing occupies it, or else as soon as nothing does. |
| `box.remove { box }` | Remove a box, running or not, its container and its record. |
| `box.lease { box, occupant, start? }` | Occupy a box, `occupant` its holder's `{ kind, id }`, so that it is not stopped for being idle, until `box.release`, or the client's connection's end; with `start`, the default, once it is started. Answers `{ lease }`. |
| `box.release { lease }` | End a lease. |
| `box.watch { box }` | A box's state, as an event now and at each change, until the request is cancelled or the box removed. |
| `box.request { box, method, params, hold? }` | A request of the box's helper (docs/fleet-box/helper/index.md), answered as the helper answers it, with its events: with `hold`, the default, occupying the box while it runs, starting it if need be; without, of a box that is started. |
| `box.copyIn { box, from, to }` | Copy a host file to a path in the box, or a host folder's contents into a folder there. |
| `box.copyOut { box, from, to }` | Copy a box folder's contents into a host folder. |
| `box.pipe { box, argv, input?, output? }` | Run a program in the box for bytes, occupying it while it runs: `input`, a host file, its stdin; its stdout to `output`, a host file, or given back as `{ stdout }`. |
| `service.register { name, description, package, env?, endpoint }` | Register a service, the client's while its connection lasts (docs/fleet/services/index.md). |
| `service.unregister { name }` | Unregister a service the client registered. |
| `service.list {}` | The services registered, each with its commands. |

## Design

- **Parts are given what they use**, as one object of named dependencies:
  `FleetHost` its `Registry`, the folder it stages services in, its
  `Platform` (`platform.ts`: `log`, `now`, `newId` and `after`, a timer
  that keeps nothing alive) and its `Boxes`, Docker's containers through
  `Box` unless a test gives local ones; each box is a `ManagedBox`
  (`managed.ts`), with its `Channel` (`channel.ts`); the services are
  `Services` (`services.ts`); and the socket is `server.ts`'s. A test serves a host in its own process, its
  boxes folders with the helper as built running in each.
- **A box** is made with a spec: its image, the host's default without one,
  `fleet:local` unless `fleet serve --image` names another; its labels, its
  creator's, which the host keeps, lists, puts on the container as
  `fleet.label.<key>`, and tells each service a connection of the box's
  goes to; its environment, that of every process in it; the services it
  has, by name, every one registered without them; and how long it runs
  idle, 60 s by default, `fleet serve --idle-stop` otherwise. Its id,
  `box-` and 16 hex digits, names its container. Its record is written once
  its container is made, so a host started later knows it.
- **Its state** is `stopped`, `started`, its helper running, `stopping`, or
  `gone`, its container removed by other means. `box.watch` follows it, and
  `removed` ends the watch.
- **Leases.** What occupies a box keeps it from being stopped for being
  idle; when the last leaves, the box stops after its idle time, unless
  something occupies it again meanwhile, and `stopWhenVacant` has it stop as
  soon as the last leaves. A lease is its client's: when the client's
  connection ends, every lease it held is released, so a harness that dies
  holds no box up. A request that holds the box, and a pipe, take a lease of
  their own while they run.
- **One operation at a time.** A box's operations, a start, a stop, a copy,
  a removal, run one after another; requests of its helper run as they
  come.
- **A start** starts the container, starts a new helper in it, and puts the
  box's services in it (docs/fleet/services/index.md) before anything else
  uses it; a start that fails leaves it stopped.
- **A box gone.** A box whose container is not there when it is asked to
  start fails with `BOX_GONE`, and is `gone`: the host does not make it
  again, since only its owner knows what was in it; the owner makes another.
  A box the host does not know fails with `NO_BOX`, and a request without
  `hold` of a box that is not started with `NOT_STARTED`. A helper's own
  failure keeps its code, such as an `FsError`'s.
- **The box's API** is its helper's methods, but `hello`, `echo` and
  `services.*`, which are the host's own: files, processes and terminals,
  as a harness serves its agent's tools from them. What the box sends is
  checked as the helper connection checks it (docs/fleet/box/index.md).
- **Copies and pipes name host paths**, since the host and its clients are
  on one machine, and its socket is its owner's alone; `copyIn` and
  `copyOut` work whether the box runs or not.
- **A host started later** knows the boxes its registry has; one whose
  container still runs, as a host that stopped left it, without a helper,
  stops once it has been idle long enough, as one started here does.
- **When the host stops**, it stops the boxes it started; their helpers end
  with it, and with them the processes they ran.
- **The socket** has mode 0600, its folder made with mode 0700, so only its
  owner can open it, which is its authentication; the host takes it over
  only if no host answers on it.
- **Each box has a channel**, the one way from the box to the host: a
  socket the host listens on in a folder of the box's own,
  `channels/<id>/`, which the box's container mounts at
  `/run/fleet/host`, as a box in the cloud would have one connection to its
  gateway. The helper makes one HTTP/2 connection to it, and each
  connection a program in the box opens to a service's socket is a stream
  of it, which the host passes on to the service
  (docs/fleet/services/index.md). A stream that comes in on a box's channel
  is that box's, so the box never says who it is. `channels/` has mode
  0700, so no one else on the host reaches a channel; a box's folder, mode
  0711, and its socket, 0666, let the box's root reach it whatever its user
  is on the host. The host listens on a box's channel as it makes the box,
  or knows it from its registry, and removes the folder with the box; a box
  made by a host before channels has none, and reaches no service.

## Not yet

- A helper that exits on its own leaves its box `started`: its requests
  fail until the box is stopped and started again.
- Nothing removes a box its creator forgets: `fleet box list` shows it, and
  `fleet box rm` removes it.

## Built on

- The Docker CLI, through `Box` (docs/fleet/box/index.md).
- `@sleepymug/fleet-box`, for the image and the staging of packages
  (docs/fleet-box/image/index.md), and the helper it holds.
- `@sleepymug/fleet-protocol`, for the wires and the layout of a box
  (docs/fleet-protocol/index.md).

## How it runs

After `pnpm build` and `pnpm image`, `fleet serve` serves the host on
`~/.fleet/fleet.sock`, and prints what it does on stderr:

```
$ fleet serve
fleet: serving on /home/me/.fleet/fleet.sock
fleet: registered the service tau, its package 2fb950ceb9ac6fe4, its commands tau
fleet: created box-e732eed074b4ff6e, dsh.session=session-ee23… tau.title=relay
fleet: removed box-e732eed074b4ff6e
```
