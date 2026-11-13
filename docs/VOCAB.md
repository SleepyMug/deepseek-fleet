# Vocabulary

The names fleet gives things, and what each names, and the names it no
longer uses. fleet's docs and code use these, and no others. How each thing
works is its own doc's to say.

## The gateway and its boxes

| Name | What it is |
|---|---|
| **gateway** | The one process that keeps the boxes and their lifetime, takes in the services that plug into it, and carries each box's calls to them. |
| **host** | The machine the gateway and the fleet servers run on. A **host path** is a path there. |
| **fleet home** | The gateway's folder on the host. |
| **box** | A container the gateway made, with the helper in it while it runs. |
| **image** | What a box runs. |
| **helper** | fleet's process in a running box, which serves the box to the gateway, and the box's services to its programs. |
| **channel** | A box's one connection to the gateway, which says which box what comes over it is from. |
| **labels** | What a box's creator says of it, keys and values. |
| **lease** | A hold on a box, by an **occupant**, that keeps it from being stopped for being idle. |
| **idle stop** | A box stopping once nothing has occupied it for its idle time. |
| **harness** | A client of the gateway that makes boxes and runs agents in them, such as dsh-tau. |
| **fleet-sdk** | What harnesses and fleet servers talk to the gateway with. |

## Services

| Name | What it is |
|---|---|
| **service** | Something a box's programs call, plugged into the gateway by its name, and served by its fleet server. |
| **fleet server**, **server** | The process that registered a service with the gateway, and serves its calls: fleet-notes for notes, dsh, through dsh-tau, for tau. **Server** alone where it cannot be taken for another. |
| **endpoint** | Where a fleet server takes the calls the gateway carries to it. |
| **registration** | A service plugged in, for as long as the fleet server that registered it stays connected. |
| **preamble** | What the gateway tells a fleet server first of each call: the box it comes from, as the gateway knows it, never as the box says, and the box's labels. |
| **service socket** | Where a box's programs reach a service, in the box. |
| **service folder** | Where a service's things are in a box. |
| **package** | A node package of a service's own, which the gateway puts in each box that has the service. |
| **command** | A program of a service's package, on the PATH in a box that has the service. |
| **staging** | The gateway keeping a copy of a service's package, as installed on the host, to put in boxes. |
| **provisioning** | The gateway putting a box's services in it as it starts, before anything else uses it. |

## Names no longer used

| Name | What took its place |
|---|---|
| fleet host, host, for the process `fleet serve` runs | The gateway; host is the machine alone. |
| gateway, for a service's process on the host | Its fleet server. |

## Not yet

- How a service defines its calls, and what a box's programs call it with,
  is not decided.
