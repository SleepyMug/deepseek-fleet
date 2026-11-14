# fleet

fleet's gateway, `@sleepymug/fleet`: the hub everything dials. It keeps
boxes, each a container with fleet's helper in it while it runs
(docs/fleet-box/helper/index.md), for as long as their creators want them,
and stops each once nothing has used it for a while; it takes in services,
each served by its fleet server over a tunnel the server opens to it
(docs/fleet/services/index.md); and it carries each call to where it goes:
a box's to its helper, a service's to its server. It dials nothing itself,
so a box, the gateway and a service's server may each be on a machine of
its own. It knows nothing of tau or dsh: a box is its id, its labels and
its services; a service is its name, its schema and its server. The names
fleet gives things are docs/VOCAB.md's.

## Provides

- `fleet` (docs/fleet/cli/index.md), the command: `fleet serve` runs the
  gateway; the others are its clients.
- `@sleepymug/fleet/gateway`: `FleetGateway.open({ paths, driver, platform,
  image })`, the gateway in its home, and `serve(gateway,
  { clients, boxes })`, which serves it on its two sockets; `fleetPaths`,
  `systemPlatform`; and its drivers, `DockerDriver` and `LocalDriver`.

The gateway's **home** is `$FLEET_HOME`, or `~/.fleet`:

| Place | What it holds |
|---|---|
| `fleet.sock` | Its clients' socket, unless `$FLEET_SOCKET` names another: its owner's alone, mode 0600. |
| `gateway/gateway.sock` | Its boxes' socket, in a folder each box mounts at `/run/fleet/gateway`. |
| `boxes/<id>.json` | Each box it made, as it made it: its id, image, labels, environment, services with their specs, and when (`boxes/registry.ts`). |
| `specs/<digest>.json`, `.binpb` | Each service's spec as staged, and its schema (`services/specs.ts`). |
| `store/<digest>/` | Trees by their digest: services' packages, their clients, and what the clients import (`store.ts`). |

## Its HTTP/2 surface

Both sockets take HTTP/2 and HTTP/1.1 alike (docs/fleet-net/index.md), so
a Connect, gRPC or gRPC-Web client calls the gateway, and so does curl for
a call that answers once. What is where is fleet-protocol's wire
(docs/fleet-protocol/index.md):

| On | Path | What it is |
|---|---|---|
| clients' | `/fleet.gateway.v1.Boxes/*`, `/fleet.gateway.v1.Services/*` | The gateway's own API (below). |
| clients' | `/boxes/<id>/fleet.box.v1.Box/*` | A box's API, carried to the helper of the box, started; a box that is not fails, `NOT_STARTED`, and the call starts none. |
| clients' | `/services/<name>/<package>.<Service>/*` | A service, carried to its server, told the call is a client's. |
| clients' | `/fleet/tunnel`, a WebSocket | A service's server's tunnel, naming the service and its spec. |
| boxes' | `/fleet/tunnel`, a WebSocket | A box's helper's tunnel, naming its box. |
| boxes' | `/services/<name>/<package>.<Service>/*` | A service, called by a box's program, which the box's helper carries saying which box; carried to the service's server, told the box and its labels, if the box was made with the service. |

A call is carried as it came, its headers, body and trailers, both ways as
they come, never decoded; a caller's `fleet-` headers are dropped, so what
fleet's headers say, the gateway alone says. A call refused is refused as
its protocol has it, with a `fleet.gateway.v1.Failure` detail giving the reason:
`NO_BOX`, `BOX_GONE`, `NOT_STARTED`, `NO_SERVICE`, `UNKNOWN_SPEC`,
`NO_PACKAGE` or `NAME_TAKEN`.

The gateway's API, `fleet.gateway.v1` (packages/fleet-protocol/proto/fleet/gateway/v1):

| Method | What it does |
|---|---|
| `Boxes.Create { image, labels, env, services }` | Make a box, stopped, with the services it names, each as registered now, and give it back. |
| `Boxes.List { labels }`, `Boxes.Get { box }` | Every box, oldest first, or those whose labels hold each of `labels`; one box. |
| `Boxes.Start`, `Stop`, `Remove { box }` | A box's life: started, it runs until it is stopped. |
| `Boxes.Watch { box }` | The box's state, now and at each change, until it is removed or the call is cancelled. |
| `Services.Stage { name, description, schema, services, package, env }` | Stage a service's spec: check it, make its client, keep both; answer its digest, and whether the package is to be uploaded. |
| `Services.Upload`, a stream | Take in a package: its digest, then its tar archive. |
| `Services.List {}` | The services registered now. |

## Design

- **Two layers.** The domain, `gateway.ts` with `boxes/` and `services/`,
  keeps the boxes and the services and never sees HTTP; the surface,
  `http/server.ts` with `api/`, holds nothing, and asks the domain where
  each call goes. Each part is given what it uses: `FleetGateway` its home's
  paths, its `BoxDriver`, and its `Platform` (`platform.ts`: `log`, `now`,
  `newId` and `after`, a timer that keeps nothing alive).
- **A driver keeps the containers** (`boxes/driver.ts`): it makes, starts,
  stops and removes a box's container, and says whether it runs; nothing
  else. `DockerDriver` runs Docker's CLI: each container named by its box's
  id, labelled `fleet.box` and `fleet.label.<key>`, with an init first, the
  helper as its command, told the gateway's socket and its box's id, and the
  folder of the boxes' socket mounted. `LocalDriver` makes a box a folder
  here, its layout rooted there, and the helper as built a process here, for
  tests and for trying fleet out; nothing isolates such a box.
- **A box's helper dials in** (`boxes/managed.ts`). A start starts the
  container, waits for the helper's tunnel, a container that stops first
  failing the start, gives the box its services' tree unless it holds it,
  and only then is the box `started`: `STOPPED`, `STARTING`, `STARTED`,
  `STOPPING`, or `GONE`, its container removed by other means. A helper that
  dials in for a box the gateway did not start, as one a gateway before this
  one left running, has its box taken as started.
- **A box's services are fixed when it is made**: each name, as registered
  then, with its spec. Its tree (`boxes/contents.ts`) is made from them, so
  it is fixed too, and named by the digest of what it is made from: each
  client in `node_modules/@fleet/<name>`, with what the clients import,
  fleet-service-client, staged from the gateway's own install, so
  the clients and what they import never drift apart and no image holds
  them; each service's own package in `services/<name>`, its commands linked
  in `bin`, made executable; and the box's README, `README.md`. The helper
  installs it at `/fleet` as the box first starts. Its environment is its
  services', then its creator's, given the container as it is made.
- **When a box runs is its creator's to say.** A box runs from its start
  until it is stopped, or removed; the gateway starts and stops none of its
  own accord, and a call of a box's API needs the box started, which the
  call does not do. Whatever its creator knows of what uses the box, such as
  dsh-tau's idle stop (docs/dsh-tau/tau/index.md), is its creator's.
- **One operation at a time.** A box's operations, a start, a stop, a
  removal, run one after another; calls of its API run as they come.
- **A box's record comes first.** The gateway writes a box's record before
  it makes its container, and removes the container before the record, so
  a gateway that dies on the way leaves a record without a container, a
  box gone, never a container no record knows; a container that cannot be
  made has its record deleted.
- **A box gone.** A box whose container is not there when it is asked to
  start fails with `BOX_GONE`, and is `GONE`: the gateway does not make it
  again, since only its owner knows what was in it.
- **A gateway started later** knows the boxes its registry has, and the
  specs its home keeps; a running box's helper and a service's server dial
  it again on their own, the server staging its spec again if the gateway
  lost it.
- **When the gateway stops**, its boxes run on, their helpers dialing the
  next gateway, but a driver's whose boxes cannot outlive it, as
  `LocalDriver`'s, which it ends as it closes (`BoxDriver.close`).

## Not yet

- Its sockets are Unix sockets alone, the clients' its owner's, which is
  its authentication, and the boxes' reachable from every box, which says
  its own id: a box could claim another's. TLS, a TCP listener, tokens with
  scopes, and a credential for each box are the security pass's.
- A box on another machine needs a driver there, a process of its own that
  dials the gateway and keeps the containers, behind the same `BoxDriver`.
- Nothing removes a box its creator forgets: `fleet box list` shows it, and
  `fleet box rm` removes it.

## Built on

- `@sleepymug/fleet-protocol` (docs/fleet-protocol/index.md), fleet-net
  (docs/fleet-net/index.md), fleet-pack (docs/fleet-pack/index.md) and
  fleet-codegen (docs/fleet-codegen/index.md).
- `@connectrpc/connect-node`, for the gateway's own API.
- The Docker CLI, through `DockerDriver`; fleet-box, for the image and the
  local driver's helper.

## How it runs

After `pnpm build` and `pnpm image`, `fleet serve` serves the gateway in
`~/.fleet`, and prints what it does on stderr:

```
$ fleet serve
fleet: serving on /home/me/.fleet/fleet.sock, and to its boxes on /home/me/.fleet/gateway/gateway.sock
fleet: registered the service notes, its spec df25104f81f2
fleet: created box-2ba2a3b021b9ddef who=me
fleet: removed box-2ba2a3b021b9ddef
```
