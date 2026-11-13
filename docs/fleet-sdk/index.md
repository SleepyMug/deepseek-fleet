# fleet-sdk

The gateway's SDK, `@sleepymug/fleet-sdk`: what a harness uses of the
gateway's boxes, their lives and their API; what a fleet server serves its
service to the gateway with; and who calls a service, as the gateway says
(docs/fleet/index.md). It holds one HTTP/2 connection to the gateway's
clients' socket, dialed again as a call needs it once it is lost, which
carries every call the client makes; a service it serves goes over a tunnel
of its own.

## Provides

```ts
import { Fleet } from '@sleepymug/fleet-sdk'

const fleet = await Fleet.connect()                       // $FLEET_SOCKET, or fleet.sock in the fleet home
const { id } = await fleet.create({ labels: { who: 'me' }, services: ['notes'] })
const box = fleet.box(id)
const release = await box.lease({ kind: 'turn', id: 'agent-1' })   // started, and occupied
await box.output(['ls', '/fleet'])                        // what it wrote to stdout
for await (const { response } of box.api.spawn(requests())) { /* started, stdout, stderr, exit */ }
await box.putPath('/here/work', '/work')                 // a folder's contents into the box
await release()
await fleet.close()                                      // what the client held, the gateway lets go
```

`Fleet`:

| Member | What it does |
|---|---|
| `Fleet.connect({ socket?, log? })` | Connect to the gateway, which must answer now, else `FleetUnreachable`; `log` is told what goes wrong outside a call, as a tunnel lost. |
| `boxes`, `services` | The gateway's own API, `fleet.v1.Boxes` and `Services`, as Connect clients. |
| `create(spec)`, `list(labels?)`, `serviceList()` | `Boxes.Create`, `Boxes.List` and `Services.List`. |
| `box(id)` | A `FleetBox`, to ask of. |
| `client(name, Service)` | A service's client, which calls it through the gateway as a client. |
| `serve(definition)` | Serve a service to the gateway (docs/fleet/services/index.md), and settle once it is registered, its `Registration`, `{ spec, close() }`. |
| `close()` | Close the client: its services' tunnels, its leases and watches, and its connection. |

`FleetBox`:

| Member | What it does |
|---|---|
| `api` | The box's API, `fleet.box.v1.Box`, the box held while each call lasts, started if it is not. |
| `started` | The same, of a box that is started, which a call neither holds nor starts; one not started fails, `NOT_STARTED`. |
| `info()` | The box, with its state. |
| `start()`, `stop()`, `stopWhenVacant()`, `remove()` | Its life. |
| `lease(occupant, { start? })` | Occupy the box, `occupant` `{ kind, id }`, until the returned release; with `start`, the default, once it is started. |
| `watch(listener)` | Follow its state: `listener` is told it now, at each change, and `removed` once it is gone, until the returned stop. |
| `exec(argv, { cwd?, env?, stdin? })`, `output(argv, …)` | Run a program to its end: how it ended and what it wrote; or what it wrote to stdout, an exit other than 0 failing with its stderr. |
| `put(archive, to)`, `putPath(from, to)` | A tar archive, or a folder's contents or a file on this machine, into a folder of the box. |
| `get(from)`, `getPath(from, to)`, `getFile(from, to)` | A folder of the box, or a file, as a tar archive, or into a folder or a file here. |

A server reads who calls with `callerOf(ctx)`, a `fleet.v1.Caller`, or
`boxOf(ctx)`, the box's `{ id, labels }`, a call from elsewhere refused.
The gateway's failures are `ConnectError`s, whose reason `reasonOf(error)`
gives, a `Reason`: `NO_BOX`, `BOX_GONE`, `NOT_STARTED`, `NO_SERVICE`,
`UNKNOWN_SPEC`, `NO_PACKAGE` or `NAME_TAKEN`.

## Design

- **One connection** carries every call, many at once, from one process;
  connect-node's session manager dials it again as a call needs it, after
  the gateway restarts. A call asked while no gateway answers fails.
- **A lease is a call**: held while it lasts. One lost with the connection
  is taken again, after a pause, a tenth of a second at first, twice as long
  each time, up to two seconds, as occupancy without a start, since what
  held the box asks for it again as it needs it; one whose box is gone is
  not. A watch is followed again the same way, its listener told the state
  then.
- **A service served** is staged, its package staged as installed here
  (docs/fleet-pack/index.md) and uploaded if the gateway lacks it, and its
  tunnel kept open, opened again once lost, the spec staged again if the
  gateway no longer knows it (docs/fleet/services/index.md).

## Built on

- `@sleepymug/fleet-protocol`, for the API and the wire; fleet-net, for the
  connection and the tunnels; fleet-pack, for packages and trees.
- `@connectrpc/connect` and `@connectrpc/connect-node`.
