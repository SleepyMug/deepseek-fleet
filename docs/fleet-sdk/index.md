# fleet-sdk

The gateway's SDK, `@sleepymug/fleet-sdk`: what a harness uses of the
gateway's boxes, their files, processes and terminals, and their lives;
and what a fleet server registers itself with (docs/fleet/index.md). It
speaks the gateway's wire on its socket (docs/fleet-protocol/index.md), one
connection that carries every request the client asks, and holds its
leases and services as long as it lasts. dsh-tau runs its taus' boxes with
it (docs/dsh-tau/tau/index.md); fleet-notes registers with it
(docs/fleet-notes/index.md).

## Provides

```ts
import { Fleet } from '@sleepymug/fleet-sdk'

const fleet = await Fleet.connect()                  // $FLEET_SOCKET, or fleet.sock in the fleet home
const { id } = await fleet.create({ labels: { who: 'me' } })
const box = fleet.box(id)
const release = await box.lease({ kind: 'turn', id: 'agent-1' })   // started, and occupied
await box.request('fs.stat', { target })                   // a helper method, holding the box while it runs
await box.exec(['ls', '/'])                                // what it wrote to stdout
await release()
await fleet.close()                                        // what the client held, the gateway lets go
```

`Fleet`:

| Member | What it does |
|---|---|
| `Fleet.connect({ socket?, log? })` | Connect to the gateway, which must answer now: the socket `$FLEET_SOCKET`, or `fleet.sock` in the fleet home, unless `socket` names another; `log` is told what goes wrong outside a request, such as a connection lost. |
| `request(op, params, { onEvent?, signal? })` | Ask any op of the wire, and give its result; `onEvent` is told each event first; aborting `signal` cancels it. |
| `create(spec)`, `list(labels?)` | `box.create` and `box.list`. |
| `box(id)` | A `FleetBox`, to ask of. |
| `register(definition)` | Register a service (below), and give its `Registration`, `{ info, unregister() }`. |
| `close()` | Close the connection: the gateway releases the client's leases and unregisters its services. |

`FleetBox`, each verb the op of its name (docs/fleet/index.md):

| Member | What it does |
|---|---|
| `get()` | The box, with its state. |
| `request(method, params, { onEvent?, hold?, signal? })` | A request of the box's helper; with `hold`, the default, occupying the box while it runs, starting it if need be; without, of a box that is started. |
| `lease(occupant, { start? })` | Occupy the box, `occupant` `{ kind, id }`, and give back what releases it; with `start`, the default, once it is started. |
| `watch(listener)` | Follow the box's state: `listener` is told it now and at each change, until the returned stop, or the box's removal. |
| `start()`, `stop()`, `stopWhenVacant()`, `remove()` | The box's life. |
| `copyIn(from, to)`, `copyOut(from, to)` | Copy a host file or folder in, or a box folder out, host paths absolute. |
| `pipe(argv, { input?, output? })` | Run a program for bytes: `input`, a host file, its stdin; its stdout to `output`, a host file, or given back. |
| `exec(argv)` | Run a program in the box, and give back what it wrote to stdout; an exit other than 0 fails, with what it wrote to stderr. |

A service, as `register` takes it, `ServiceDefinition`: `name`,
`description`, `package`, a node package installed on this host, absolute,
`env`, and `serve(connection, from)`, which serves each connection a
program in a box opens to the service's socket there, as a socket on this
host, `from` the `Preamble`, `{ box, labels }` (docs/fleet/services/index.md).

It also exports `FleetError`, a failure the gateway reported, with its `code`:
`BOX_GONE`, `NO_BOX` and `NOT_STARTED`, which it exports too, or a helper's,
such as an `FsError`'s; `FleetUnreachable`, for no gateway on the socket;
`fleetHome` and `fleetSocket`; and the wire's types.

## Design

- **One connection** carries every request, each with an id of the
  client's, answered in any order: many at once, from one process, such as
  dsh's world serving many sessions' tools.
- **A service's endpoint** is a socket of the client's own, in a folder of
  its own made in the system's temporary folder, mode 0700, which the
  gateway opens a connection to for each one a box opens. The client reads
  the line that says which box it comes from, as the gateway knows it, and
  gives `serve` the rest of the connection, which flows once `serve` reads
  it, as with a `data` listener, a pipe, or tau's `serveConnection`. A line
  that is no `Preamble` cuts the connection, and so does a `serve` that
  throws.
- **A connection the gateway loses is made again,** after a pause, a tenth
  of a second at first, twice as long each time, up to two seconds, until a
  gateway answers or the client is closed: as after `fleet serve` restarts.
  What was asked on the lost connection fails, the asker's to ask again;
  then the client registers its services again, takes each lease it still
  holds again, as occupancy, without starting the box, since what held it
  asks for the box again as it needs it, and follows each watch again, whose
  listener is told the state now. A request asked while no gateway answers
  fails with `FleetUnreachable`.
- **Who the client is,** the gateway learns from the connection: its leases
  and its services are that connection's, and what it registered another
  client cannot unregister.

## Built on

- `@sleepymug/fleet-protocol/fleet` and `/helper`, for the wire and its types.
- Node's `net` and `readline`.

## How it runs

```ts
import { Fleet } from '@sleepymug/fleet-sdk'

const fleet = await Fleet.connect({ log: message => console.error(message) })
await fleet.register({
  name: 'echo',
  description: 'Says back what it is sent.',
  package: '/home/me/echo-box',               // with "bin": { "echo-back": "bin/echo-back.js" }
  serve: (connection, { box }) => { connection.pipe(connection) },
})
```

Each box then has `echo-back` on its PATH, which reaches `serve` through
`$FLEET_SERVICES/echo.sock`.
