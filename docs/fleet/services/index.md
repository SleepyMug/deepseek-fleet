# fleet/services

Services of the gateway (docs/fleet/index.md). A service is:

- **its schema**, protobuf services and their messages, with their
  comments, as `buf build` makes it, every file it imports with it;
- **its fleet server**, a process anywhere that can dial the gateway, which
  stages the service's spec and opens a tunnel to the gateway naming it,
  then serves the service's calls over that tunnel as any Connect server
  does, each told who calls: a box, with its labels, or a client;
- **its client**, which the gateway makes from its schema
  (docs/fleet-codegen/index.md) and puts in each box made with the service,
  `@fleet/<name>`, whose methods call the service, and whose declarations
  say what each means;
- and, if it has one, **its package**, a node package of its own, which
  each box made with the service gets in `/fleet/services/<name>`, its
  commands on the PATH.

The gateway knows nothing of what a service does: it checks its spec,
makes its client, puts it in the boxes, and carries its calls, never
decoding them.

## Provides

A service registers with fleet-sdk's `serve` (docs/fleet-sdk/index.md), its
schema and routes those of its generated code:

```ts
import { Fleet, boxOf } from '@sleepymug/fleet-sdk'
import { descriptors } from './gen/descriptors.ts'      // its schema, as buf build makes it
import { Notes } from './gen/notes/v1/notes_pb.ts'       // protoc-gen-es's

const fleet = await Fleet.connect()                      // $FLEET_SOCKET, or ~/.fleet/fleet.sock
const registration = await fleet.serve({
  name: 'notes',                                         // its path, /services/notes/, and its client, @fleet/notes
  description: 'A notebook of short notes for this box.',
  schema: descriptors(),
  services: [Notes],
  package: '/…/node_modules/some-box-package',           // optional: a package of its own, for its commands
  env: { NOTES_STYLE: 'terse' },                         // optional: for every process in a box made with it
  routes: router => router.service(Notes, {
    add: (req, ctx) => notebooks.add(boxOf(ctx).id, req.text, req.tags),
    tagged: (req, ctx) => ({ notes: notebooks.tagged(boxOf(ctx).id, req.tag) }),
  }),
})
registration.close()                                     // or the client's end does it
```

What the gateway gives a box made with a service, and no more:

| What | Where in the box |
|---|---|
| its client, `@fleet/<name>`: `index.js`, `index.d.ts`, protoc-gen-es's files, `README.md` | `/fleet/node_modules/@fleet/<name>` |
| what the clients import: `@bufbuild/protobuf`, `@connectrpc/connect`, `@connectrpc/connect-node` | `/fleet/node_modules` |
| its package, if it has one | `/fleet/services/<name>` |
| each of the package's commands, its `bin`, a link | `/fleet/bin/<command>`, first on every program's PATH |
| what the box has, and how a program uses it | `/fleet/README.md` |
| the one socket every service is reached on, which the helper relays to the gateway | `/run/fleet/services.sock`, `$FLEET_SERVICES_SOCKET` |
| what its spec adds to the environment | every process's environment |

A program below `/fleet`, such as `/fleet/programs/shop.mts`, imports the
clients as Node finds them, `import { notes } from '@fleet/notes'`, and
runs with `node`; one elsewhere links `/fleet/node_modules/@fleet` into a
`node_modules` above it first. A shell calls a method that answers once
with its request as JSON:
`curl -s --unix-socket /run/fleet/services.sock -H 'content-type: application/json' -d '{"tag":"shop"}' http://fleet/services/notes/notes.v1.Notes/Tagged`.

## Design

- **Staging and the tunnel.** A server stages its spec, `Services.Stage`:
  its name, description, schema, the protobuf services it serves, its
  package's digest, and its environment. The gateway checks it, a name of
  lowercase letters, digits and hyphens, a schema whole, each service named
  in it, and makes its client, keeping both under the spec's digest; the
  same spec staged again is the one kept, so staging is not registering. If
  the gateway lacks the package, the server uploads it, `Services.Upload`,
  checked to have its digest. Then the server opens its tunnel, a
  WebSocket at `/fleet/tunnel`, its subprotocol `fleet-tunnel`, naming the
  service and the spec, after which the WebSocket carries HTTP/2, the gateway the client and the
  server the server (docs/fleet-net/index.md). The service is registered
  for as long as the tunnel lasts.
- **One server a name.** A tunnel for a name another server serves now is
  refused, `NAME_TAKEN`, which fleet-sdk does not wait out. A spec the
  gateway does not know, as after it lost its home, is refused,
  `UNKNOWN_SPEC`, or its package, `NO_PACKAGE`, which fleet-sdk stages and
  uploads again before it opens the tunnel again.
- **A tunnel lost is opened again**, after a pause, a tenth of a second at
  first, twice as long each time, up to two seconds, as when the gateway
  restarts; meanwhile the service's calls fail, `NO_SERVICE`.
- **The calls.** A box's programs call the service on the box's services'
  socket, which the box's helper carries to the gateway, saying which box;
  the gateway carries a call on, at the service's path less its prefix,
  over the service's tunnel, if the box was made with the service, and
  says who calls in `fleet-caller-bin`, a `fleet.v1.Caller`: the box's id
  and labels, as the gateway knows them, or a client. fleet-sdk's
  `callerOf(ctx)` and `boxOf(ctx)` read it. A client of the gateway calls a
  service at `/services/<name>/` on the clients' socket, as fleet-sdk's
  `client(name, Service)` does.
- **A box's services are fixed when it is made**, each with its spec as it
  was then; its client is that spec's, whichever spec the service's server
  serves since, so a server keeps its schema compatible, as protobuf has
  it, while boxes made with an older one run.
- **The threat model.** The model controls everything in a box, so a
  service checks what a box sends, and decides what it may do by the box
  the gateway says it is, and its labels: fleet-notes gives each box a
  notebook of its own. Every box made with a service can call it.

## Built on

- fleet-codegen, for the clients; fleet-pack, for the packages and the
  trees; fleet-net, for the tunnels and the carrying of calls.
- fleet-sdk's `serve`, `callerOf` and `boxOf`, for a server
  (docs/fleet-sdk/index.md).
