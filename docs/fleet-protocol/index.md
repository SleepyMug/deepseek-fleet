# fleet-protocol

fleet's contracts, shared by its ends, so that no end imports another, and
a harness or a fleet server imports none of the gateway's code: the
gateway's API and a box's, as protobuf services; the paths and headers of
the gateway's HTTP/2 surface; and where things lie in a box. Its schemas
are in `proto/`, its code generated from them in `src/gen/`, by `pnpm gen`
(buf and protoc-gen-es, `scripts/gen.mjs`), and kept with the sources.

## Provides

- `@sleepymug/fleet-protocol/gateway`: fleet.gateway.v1
  (`proto/fleet/gateway/v1`), the gateway's API: `Boxes`, `Services`, and
  their messages; `Caller`, who calls a service, as the gateway tells its
  server; and `Failure`, with its `Reason`, why the gateway refused a call.
- `@sleepymug/fleet-protocol/box`: fleet.box.v1 (`proto/fleet/box/v1`), a
  box's API, which its helper serves: `Box`, its processes, terminals,
  files and trees; and `Provision`, which the gateway alone asks.
- `@sleepymug/fleet-protocol/wire`: the HTTP/2 surface: `routeOf(path)`,
  where a call goes, `{ kind: 'gateway' }`, `{ kind: 'service', name,
  path }` or `{ kind: 'box', box, path }`; `servicePath(name)` and
  `boxPath(id)`; `TUNNEL_PATH`, `/fleet/tunnel`, and `TUNNEL_PROTOCOL`,
  `fleet-tunnel`, a tunnel's WebSocket subprotocol; `HEADERS`, fleet's own, below; `HELPER_PROTOCOL`, the
  helper's tunnel's version; `SERVICE_NAME` and `BOX_ID`; and
  `encodeCaller` and `decodeCaller`.
- `@sleepymug/fleet-protocol/layout`: where things lie in a box, which the
  gateway, the helper and the box's programs agree on, `boxLayout(root)`,
  `BOX_LAYOUT` the box's own:

  | Name | Value |
  |---|---|
  | `IMAGE_DIR`, `HELPER_NODE`, `HELPER_ENTRY` | `/opt/fleet`, fleet-box as it would be packed; `/usr/local/bin/node`; `/opt/fleet/lib/helper/main.js` |
  | `fleet`, `bin`, `services`, `modules`, `readme` | `/fleet`, what the gateway installs; `/fleet/bin`; `/fleet/services`; `/fleet/node_modules`; `/fleet/README.md` |
  | `TREE` | the same, relative to `/fleet`, as the gateway composes it |
  | `servicesSocket`, `SERVICES_SOCKET_VARIABLE` | `/run/fleet/services.sock`, which `$FLEET_SERVICES_SOCKET` names for every process |
  | `gatewayDir`, `GATEWAY_SOCKET` | `/run/fleet/gateway`, the gateway's folder mounted, and `gateway.sock` in it |
  | `GATEWAY_VARIABLE`, `BOX_VARIABLE`, `ROOT_VARIABLE` | the helper's: `FLEET_GATEWAY`, `FLEET_BOX`, `FLEET_BOX_ROOT` |
  | `CLIENT_SCOPE`, `clientPackage(name)` | `@fleet`, and `@fleet/<name>` |
  | `DEFAULT_IMAGE` | `fleet:local` |

- `@sleepymug/fleet-protocol/home`: `fleetHome(env)` and
  `fleetSocket(env)`: `$FLEET_HOME`, or `~/.fleet`, and `$FLEET_SOCKET`, or
  `fleet.sock` in the home.

## The headers

| Header | On | What it says |
|---|---|---|
| `fleet-tunnel` | a tunnel's opening | Its kind: `service` or `box`. |
| `fleet-service`, `fleet-spec` | a service's tunnel | The service's name, and the digest of the spec it serves. |
| `fleet-box` | a box's tunnel, and the calls its helper carries | The box's id. |
| `fleet-helper-protocol` | a box's tunnel | `HELPER_PROTOCOL`. |
| `fleet-hold` | a call of a box's API | `false`: neither hold nor start the box. |
| `fleet-caller-bin` | a call the gateway carries to a service | A `Caller`, binary, base64. |
| `fleet-reason` | a tunnel refused | A `Reason`'s name. |

## Built on

`@bufbuild/protobuf`, for the generated code.
