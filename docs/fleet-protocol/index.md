# fleet-protocol

The gateway's wires, shared by their ends, and where things lie in a box:
a package of its own, of types and constants, so that no end imports
another, and a harness or a fleet server imports none of the gateway's
code.

## Provides

- `@sleepymug/fleet-protocol/fleet`: the wire between the gateway and its
  clients (below): `FLEET_PROTOCOL`, the message types, `Ops`, each op's
  params, result and events, the box's and the service's types, `BoxSpec`,
  `BoxInfo`, `BoxState`, `Occupant`, `ServiceSpec`, `ServiceInfo` and
  `Preamble`, the codes `BOX_GONE`, `NO_BOX` and `NOT_STARTED`, and
  `fleetHome(env)` and `fleetSocket(env)`: `$FLEET_HOME`, or `~/.fleet`, and
  `$FLEET_SOCKET`, or `fleet.sock` in the home.
- `@sleepymug/fleet-protocol/helper`: the wire between the gateway and the
  helper in a box, whose methods are docs/fleet-box/helper/index.md's:
  `PROTOCOL_VERSION`, the message types, `Methods` and `ServiceInBox`.
- `@sleepymug/fleet-protocol/channel`: the box's channel to the gateway, one
  HTTP/2 connection the helper makes to the gateway's socket, each
  connection to a service's socket in the box a stream of it
  (docs/fleet/index.md, docs/fleet-box/helper/index.md):
  `servicePath(name)`, `/services/<name>`, the path of a service's streams,
  and `serviceOf(path)`; `OPENED`, `200`, the status of a stream the gateway
  passes on, and `NO_SERVICE`, `404`, of one it refuses; and
  `CONNECTION_WINDOW`, a stream's window, a mebibyte, and `CHANNEL_WINDOW`,
  the connection's, sixteen.
- `@sleepymug/fleet-protocol/layout`: where things lie in a box, which the
  gateway, the helper and the services agree on:

  | Constant | Value |
  |---|---|
  | `PACKAGE_ROOT` | `/opt/fleet`, fleet-box as it would be packed |
  | `HELPER_NODE`, `HELPER_ENTRY` | `/usr/local/bin/node`, the base image's, and `/opt/fleet/lib/helper/main.js` |
  | `SERVICES_DIR`, `serviceDir(name)` | `/opt/fleet/services`, each service's package as `<name>@<digest>`, and `/opt/fleet/services/<name>`, the one in use |
  | `BIN_DIR` | `/opt/fleet/bin`, the services' commands |
  | `SOCKETS_DIR`, `socketOf(name)` | `/run/fleet/services`, and `/run/fleet/services/<name>.sock` |
  | `SERVICES_VARIABLE` | `FLEET_SERVICES`, which names `SOCKETS_DIR` for every process |
  | `CHANNEL_DIR`, `CHANNEL` | `/run/fleet/gateway`, the gateway's folder of the box's channel, mounted, and `/run/fleet/gateway/channel.sock`, its socket |
  | `DEFAULT_IMAGE` | `fleet:local` |

## Design

The gateway's socket is a Unix socket only its owner can open, its
authentication. A client opens one connection and sends one JSON message a
line, as the gateway does back:

- client: `{ "type": "hello", "protocol": 1 }` first; the gateway answers
  `{ "type": "hello", "protocol": 1 }`, or refuses another version with
  `{ "type": "error", "id": 0, "message" }` and closes.
- client: `{ "type": "request", "id": 1, "op": "box.get", "params": { "box": "box-…" } }`,
  any number at once, each under an id of the client's;
  `{ "type": "cancel", "id": 1 }` gives one up, its signal aborted in the
  gateway, as a watch ends.
- gateway: `{ "type": "event", "id": 1, "value" }`, any number before a
  request's answer, for an op that sends them; then
  `{ "type": "result", "id": 1, "value" }`, or
  `{ "type": "error", "id": 1, "message", "code"? }`, once.

A message that is not one closes the connection. What the client holds,
its leases and the services it registered, it holds while its connection
lasts.

| Op | Params | Result | Events |
|---|---|---|---|
| `box.create` | `BoxSpec`: `{ image?, labels?, env?, services?, idleStopMs? }` | `BoxInfo` | |
| `box.list` | `{ labels? }` | `BoxInfo[]` | |
| `box.get` | `{ box }` | `BoxInfo`: `{ id, image, labels, env, services, idleStopMs?, createdAt, state }` | |
| `box.start`, `box.stop`, `box.stopWhenVacant`, `box.remove` | `{ box }` | `null` | |
| `box.lease` | `{ box, occupant: { kind, id }, start? }` | `{ lease }` | |
| `box.release` | `{ lease }` | `null` | |
| `box.watch` | `{ box }` | `null`, once cancelled or the box removed | `{ state }`: `stopped`, `started`, `stopping`, `gone`, or `removed` |
| `box.request` | `{ box, method, params, hold? }` | the method's | the method's |
| `box.copyIn`, `box.copyOut` | `{ box, from, to }` | `null` | |
| `box.pipe` | `{ box, argv, input?, output? }` | `{ stdout }` | |
| `service.register` | `ServiceSpec`: `{ name, description, package, env?, endpoint }` | `ServiceInfo`: `{ name, description, bins, env, digest }` | |
| `service.unregister` | `{ name }` | `null` | |
| `service.list` | `{}` | `ServiceInfo[]` | |

What each op does is docs/fleet/index.md's. A failure's `code` is
`BOX_GONE`, for a box whose container was removed by other means, which its
owner makes again; `NO_BOX`, for a box the gateway does not know;
`NOT_STARTED`, for a request without `hold` of a box that is not started;
or the helper's own, such as an `FsError`'s.

A service's endpoint reads one line first of each connection the gateway
opens to it, the `Preamble`, `{ "box", "labels" }`, the box the connection
comes from, as the gateway knows it, and its labels; then the box's program's
bytes, both ways (docs/fleet/services/index.md).

## Built on

Node alone.
