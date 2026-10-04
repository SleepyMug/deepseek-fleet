# fleet-image/helper

The helper is fleet's process inside a box. It does what the host asks,
from inside the container.

## Provides

- `fleet-image/helper/protocol`: the wire between the host and the helper,
  shared by both ends. It holds `PROTOCOL_VERSION`, the message types, and
  `Methods`, which gives each method's params and result.
- `lib/helper/main.js`: the helper itself. It runs only in the image, at the
  path `fleet-image/layout` gives, and is not exported.

## Design

One JSON message per line over the helper's stdin and stdout:

- host to helper: `{ "type": "request", "id": 1, "method": "echo", "params": { "text": "hi" } }`
- helper to host: `{ "type": "result", "id": 1, "value": { "text": "hi" } }`,
  or `{ "type": "error", "id": 1, "message": "…" }`

The helper answers every request exactly once, in any order. It exits when
its stdin ends.

| Method | Params | Result | |
|---|---|---|---|
| `hello` | `{}` | `{ protocol }` | The handshake. The host refuses another protocol version. |
| `echo` | `{ text }` | `{ text }` | A trivial directive. |

A new method needs three things:
- an entry in `Methods`;
- a handler in `main.ts`;
- a check of its result on the host (fleet-core's `box/helper.ts`).

## Built on

Node alone: `readline` over stdin, and JSON lines on stdout.

## How it runs

The host starts one helper per started box with
`docker exec --interactive <container> /usr/local/bin/node /opt/fleet/lib/helper/main.js`.
The helper runs until the host ends its stdin.

Outside a box, `node packages/fleet-image/lib/helper/main.js` runs it on
your terminal, where you can type requests as JSON lines.
