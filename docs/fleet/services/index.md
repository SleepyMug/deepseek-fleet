# fleet/services

Services of the fleet host (docs/fleet/index.md). A service is two halves:

- **a gateway**, on the host: a socket of its own, its endpoint, which the
  host opens a connection to for each one a program in a box opens to the
  service, and which reaches whatever the service serves: a notebook kept on
  the host, a backend that runs agents, credentials a box must not hold;
- **the means of calling it**, a node package, which the host installs in
  each box that has the service, and whose code talks to the gateway
  through the service's socket in the box: commands, a module programs
  import, or both, as the service has it, and says in its description.

A service plugs in by registering, through fleet-client
(docs/fleet-client/index.md), from any process of the host's owner, for as
long as its connection lasts. The host knows nothing of what a service
does: it stages its package, puts it in the boxes, and relays the bytes.
dsh-tau's `tau` service, whose `tau` command runs taus as the box's run's,
is one (docs/dsh-tau/tau/index.md); fleet-notes is the example
(docs/fleet-notes/index.md).

## Provides

What the host guarantees of a service, in a box that has it, and no more:
its package installed, with its dependencies, in its directory; its
package's commands, if it declares any, on the PATH; and its socket, and
the environment it gives, each place as `@sleepymug/fleet-protocol/layout`
gives it. How a box's programs use the service, by a command, or by
importing its code from its directory, is the service's to say, in its
description, the sentence a harness shows the model beside its directory
and commands, and in what its package holds, such as docs of its own:

| What | Where in the box |
|---|---|
| the service's package, as the host staged it | `/opt/fleet/services/<name>@<digest>` |
| the one in use, a link to it | `/opt/fleet/services/<name>` |
| each of its commands, its `bin`, a link into the package through the one in use | `/opt/fleet/bin/<command>` |
| its socket, which the helper listens on, and carries to the gateway over the box's channel | `/run/fleet/services/<name>.sock` |

- `/opt/fleet/bin` is first on the PATH of every process the helper starts,
  whatever environment the host gives the process, and
  `$FLEET_SERVICES`, `/run/fleet/services`, names the sockets' folder.
- What the service's spec adds to the environment, every process the
  helper starts from then on has.

A service registers with fleet-client's `register`:

```ts
import { FleetClient } from '@sleepymug/fleet-client'

const fleet = await FleetClient.connect()                    // $FLEET_SOCKET, or ~/.fleet/fleet.sock
const registration = await fleet.register({
  name: 'notes',                                             // its socket's name in a box
  description: 'A notebook of short notes, …',               // what it is, for whoever lists the services
  package: '/…/node_modules/@sleepymug/fleet-notes-box',     // a node package installed on this host, with its `bin`
  env: { NOTES_STYLE: 'terse' },                             // optional: for every process in a box that has it
  serve(connection, { box, labels }) {                       // each connection a box's program opens, a socket
    connection.on('data', …)                                 // the program's bytes, as it sent them
  },
})
await registration.unregister()                              // or the connection's end does it
```

## Design

- **The package is staged as installed.** The host copies it as `pnpm pack`
  would pack it, with every package it depends on as installed on the host,
  in pnpm's layout, as the image takes fleet-box
  (docs/fleet-box/image/index.md), into its home's `services/`, under the
  digest of what it staged. Nothing is installed or built for a box, so a
  service's package runs on the box's Node exactly what the host installed;
  a native one must be built for linux on the host's architecture. Its
  commands are its `package.json`'s `bin`, as npm reads it; a command is
  made executable in the box, whatever its mode on the host.
- **A box gets its services as it starts**, before anything else uses it:
  the helper says which packages it holds, by digest; the host copies in
  each it lacks; and the helper makes those listed its services
  (`services.sync`, docs/fleet-box/helper/index.md). A service registered,
  or unregistered, while boxes run reaches each started box as soon as the
  host has staged it.
- **Which boxes have which services** is each box's spec: the services it
  names, or, without a list, every one registered (docs/fleet/index.md). A
  connection to a service a box does not have, or that is not registered
  now, is cut.
- **Unregistering**, by `unregister` or the end of the connection the
  service registered on, takes the service's commands, socket and
  environment from every box; its package stays, so the box gets it back at
  once when the service registers again, as after its gateway restarts.
  Only an older package of a service still registered is removed.
- **One service a name, one command a service.** A name registered by
  another client is refused, and so is a command another service has. A
  client that registers a name again replaces what it registered.
- **The gateway is told the box.** For each connection, the host opens a
  connection to the service's endpoint, writes one line of JSON first, the
  `Preamble`, `{ "box", "labels" }`, the box it comes from, as the host knows
  it, from which box's channel it came in on, never as the box says, with the
  labels its creator gave it; then it passes the bytes both ways, each end a
  half-close, a cut connection cut on both sides. fleet-client reads that
  line, and gives `serve` the rest of the connection, which flows once
  `serve` reads it. The bytes are the service's own protocol: one line of
  JSON each way, as fleet-notes has it, or tau's socket wire, as the tau
  service has it.
- **The threat model.** The model controls everything in a box, its
  service's commands included, so a service checks what a box sends, and
  decides what a box may do by the box the host says it is, and its labels:
  the tau service runs a box's runs as its run's session, which reaches only
  the runs it started; fleet-notes gives each box a notebook of its own.
  Nothing restricts a box to the services a tau names, since a tau names
  none: every box that has a service can call it. The endpoint is a socket
  of the owner's on the host, which no box reaches but through the host;
  the host's owner can open it, as the owner can everything the host does.
- **Writing a service**: a package for the boxes, whose code, commands or
  modules, is node programs, self-contained or with what they import as
  their dependencies, each finding its socket in `$FLEET_SERVICES`; a
  description, one sentence saying what it is and how a program uses it; and a process on the host
  that registers it with fleet-client, as `services/notes` does, with
  `fleet-notes` and its box package, `services/notes/box`.

## Built on

- fleet-box's `image/stage`, for staging a package as installed.
- The helper's `services.installed` and `services.sync`, and its carrying
  of the services' sockets' connections over the box's channel
  (docs/fleet-box/helper/index.md, docs/fleet/index.md).
- `Box.copyIn` (docs/fleet/box/index.md), for the packages.
- fleet-client's `register` and endpoints, for a gateway
  (docs/fleet-client/index.md).
