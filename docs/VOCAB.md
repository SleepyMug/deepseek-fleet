# Vocabulary

The names fleet gives things, what each means, and the names it no longer
uses. fleet's docs and code use these, and no others.

## The gateway and its boxes

| Name | What it is |
|---|---|
| **gateway** | The one process that keeps the boxes and their lifetime, takes in the services that plug into it, and carries each box's calls to them. `fleet serve` runs it; its clients reach it on its socket, through fleet-sdk. |
| **host** | The machine the gateway, Docker and the fleet servers run on. A **host path** is a path there, as `box.copyIn` names one. |
| **fleet home** | The gateway's folder on the host, `$FLEET_HOME` or `~/.fleet`: its socket, its boxes' records, its staged packages and its channels. |
| **box** | A Docker container the gateway made, with the helper in it while it runs: its id, `box-` and 16 hex digits, its labels, and what is in it. |
| **image** | What a box runs: Node, with fleet-box at `/opt/fleet`; `fleet:local` by default. |
| **helper** | fleet's process in a running box, which serves the box's files, processes and terminals to the gateway, and the services' sockets to the box's programs. |
| **channel** | A box's one connection to the gateway: a socket in a folder of the box's own, mounted in the box, over which the helper carries each connection a program opens to a service. The channel a connection comes in on says which box it is from. |
| **labels** | What a box's creator says of it, keys and values, which the gateway keeps, lists boxes by, and tells a fleet server each connection comes from. |
| **lease** | A hold on a box, by an **occupant**, that keeps it from being stopped for being idle, until it is released, or the connection of the client that took it ends. |
| **idle stop** | A box stopping once nothing has occupied it for its idle time. |
| **harness** | A client of the gateway that makes boxes and runs agents in them, such as dsh-tau. |
| **fleet-sdk** | What harnesses and fleet servers talk to the gateway with: `Fleet`, one connection to its socket. |

## Services

| Name | What it is |
|---|---|
| **service** | Something a box's programs call, plugged into the gateway by its name: its schema, its fleet server, and, if it has one, a package of its own. |
| **fleet server**, **server** | The process that registered a service with the gateway, and serves its calls on its endpoint: fleet-notes for notes, dsh, through dsh-tau, for tau. **Server** alone where it cannot be taken for another. |
| **endpoint** | A fleet server's socket on the host, which the gateway opens a connection to for each one a box's program opens to the service. |
| **registration** | A service plugged in, for as long as the connection of the fleet server that registered it lasts. |
| **preamble** | The line the gateway writes first on each connection to an endpoint: the box it comes from, as the gateway knows it, never as the box says, and the box's labels. |
| **service socket** | `/run/fleet/services/<name>.sock` in a box, which the helper listens on, and whose connections it carries over the channel. |
| **service folder** | `/opt/fleet/services/<name>` in a box, where the service's client and its package are. |
| **package** | A node package of a service's own, which the gateway stages and copies into each box that has the service, its commands on the box's PATH. |
| **command** | A program of a service's package, its `bin`, on the PATH of every process in a box that has the service. |
| **staging** | The gateway copying a package as installed on the host, with the packages it depends on, into the fleet home, by its digest. |
| **provisioning** | The gateway putting a box's services in it as it starts, before anything else uses it. |

## Calls

| Name | What it is |
|---|---|
| **schema** | A service's protobuf definition, which its fleet server gives the gateway as a descriptor set: its methods and messages, with their comments. |
| **method** | One call a service takes: a request, and its reply, either of them a stream for a streaming method. |
| **client** | What the gateway makes from a service's schema and puts in its service folder in each box: a module whose methods call the service over its socket, and its declarations, `index.d.ts`, for whoever writes a program to read. |
| **box README** | `/opt/fleet/README.md`, which says where each of the box's services is, and how a program calls it. |

## Names no longer used

| Name | What took its place |
|---|---|
| fleet host, host, for the process `fleet serve` runs | The gateway; host is the machine alone. |
| gateway, for a service's process on the host | Its fleet server. |
| the means of calling a service | Its client, and its package. |

## Not yet

- The calls are the design of services with schemas, which is not built:
  a service is still its package and a connection's bytes.
