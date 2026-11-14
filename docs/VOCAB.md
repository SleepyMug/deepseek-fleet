# Vocabulary

The names fleet gives things, what each means, and the names it no longer
uses. fleet's docs and code use these, and no others.

## The gateway and its boxes

| Name | What it is |
|---|---|
| **gateway** | The one process everything dials: it keeps the boxes and their lifetime, takes in the services that plug into it, and carries each call to where it goes, a box's to its helper, a service's to its server. `fleet serve` runs it. |
| **host** | The machine the gateway runs on. A **host path** is a path there, as `box.putPath` names one. |
| **fleet home** | The gateway's folder on the host, `$FLEET_HOME` or `~/.fleet`: its sockets, its boxes' records, its specs and its store. |
| **clients' socket** | `fleet.sock` in the fleet home, its owner's alone, on which harnesses and fleet servers reach the gateway. |
| **boxes' socket** | `gateway/gateway.sock` in the fleet home, mounted in every box at `/run/fleet/gateway`, on which the helpers reach the gateway. |
| **gateway API** | `fleet.gateway.v1`, the gateway's own calls: `Boxes`, which makes, lists, starts, stops, watches and removes boxes, and `Services`, which stages and lists services. |
| **box** | A container the gateway made, with the helper in it while it runs: its id, `box-` and 16 hex digits, its labels, its environment, and its services, fixed when it is made. |
| **driver** | What keeps a box's container for the gateway, making, starting, stopping and removing it: Docker's, or a local folder's, for trying fleet out. |
| **image** | What a box runs: Node, with fleet-box, the helper, at `/opt/fleet`; `fleet:local` by default. |
| **helper** | fleet's process in a running box, its command: it dials the gateway, serves the box API over its tunnel, and carries the box's programs' calls to the services. |
| **box API** | `fleet.box.v1`, a box's calls, which its helper serves: `Box`, its processes, terminals and files, and `Provision`, which the gateway alone asks. |
| **tunnel** | A connection a helper or a fleet server dials to the gateway, a WebSocket at `/fleet/tunnel`, over which the gateway then calls the dialer: what lets the gateway, which dials nothing, reach either on a machine of its own. |
| **labels** | What a box's creator says of it, keys and values, which the gateway keeps, lists boxes by, and tells a fleet server with each call from the box. |
| **occupant** | What uses a tau's session's box, as dsh-tau counts it: a turn of its agent, a call, a process or a terminal, until it is done. fleet knows none. |
| **idle stop** | dsh-tau's stopping a session's box once it is started and nothing has occupied it for the idle time; fleet stops a box only when asked. |
| **harness** | A client of the gateway that makes boxes and runs agents in them, such as dsh-tau. |
| **fleet-sdk** | What harnesses and fleet servers talk to the gateway with: `Fleet`, its boxes, each a `FleetBox`, and `fleet.serve`, which registers a service. |

## Services

| Name | What it is |
|---|---|
| **service** | Something a box's programs call, plugged into the gateway by its name: its schema, its fleet server, its client, and, if it has one, its package. |
| **fleet server**, **server** | The process that registers a service with the gateway, and serves its calls over its tunnel: fleet-notes for notes, dsh, through dsh-tau, for tau. **Server** alone where it cannot be taken for another. |
| **spec** | What a fleet server stages: the service's name, description, schema, the protobuf services it serves, its package's digest and its environment, kept by the gateway under its digest. |
| **staging** | A fleet server giving the gateway its spec, `Services.Stage`, and its package, if the gateway lacks it; staging alone registers nothing. |
| **registration** | A service plugged in, served by its fleet server, for as long as the server's tunnel lasts; one server a name. |
| **caller** | Who a call to a service is from, as the gateway tells the service's server: a box, with its id and labels as the gateway knows them, never as the box says, or a client. |
| **failure** | Why the gateway refused a call, its **reason**, as `NO_BOX` or `NO_SERVICE`, given with the call's error. |
| **store** | `store/` in the fleet home, where the gateway keeps trees by their digests: services' packages, their clients, and what the clients import. |
| **package** | A node package of a service's own, which the gateway puts in each box made with the service, at `/fleet/services/<name>`. |
| **command** | A program of a service's package, its `bin`, linked in `/fleet/bin`, first on the PATH of every process in a box made with the service. |
| **provisioning** | The gateway giving a box its services' tree at `/fleet` as it first starts, before anything else uses it. |
| **services socket** | `/run/fleet/services.sock` in a box, `$FLEET_SERVICES_SOCKET`, on which the box's programs reach every service, and which the helper carries to the gateway. |

## Calls

| Name | What it is |
|---|---|
| **schema** | A service's protobuf definition, which its fleet server stages as a descriptor set: its methods and messages, with their comments. |
| **method** | One call a service takes: a request, and its reply, either of them a stream for a streaming method. |
| **client** | What the gateway makes from a service's schema and puts in each box made with it, `@fleet/<name>` in `/fleet/node_modules`: a constant whose methods call the service, taking and giving plain objects, and its declarations, `index.d.ts`, whole in one file, for whoever writes a program to read. |
| **plain object** | A message as a client takes and gives it: its fields by their JSON names, bytes a `Uint8Array`, a 64-bit integer a number, an enum its value's name, a Timestamp a `Date`. |
| **fleet-service-client** | What every client imports, which turns plain objects into messages and back, by the schema the client embeds, and calls the service. |
| **box README** | `/fleet/README.md`, which says what services the box has, and how a program calls them. |

## Names no longer used

| Name | What took its place |
|---|---|
| fleet host, host, for the process `fleet serve` runs | The gateway; host is the machine alone. |
| gateway, for a service's process on the host | Its fleet server. |
| the means of calling a service | Its client, and its package. |
| channel, a box's connection to the gateway | The helper's tunnel. |
| endpoint, a fleet server's socket on the host | The server's tunnel: the gateway dials nothing. |
| preamble, the line the gateway wrote first to an endpoint | The caller, which the gateway tells a server with each call. |
| service socket, one a service in a box | The services socket, one for every service. |
| service folder, `/opt/fleet/services/<name>` | The client, in `/fleet/node_modules/@fleet/<name>`, and the package, in `/fleet/services/<name>`. |
| `/opt/fleet/README.md` | The box README, `/fleet/README.md`; `/opt/fleet` holds the helper alone. |
