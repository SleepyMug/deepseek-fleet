# fleet-protocol

The wire between `fleet` (fleet-client) and the tau service in the fleet host
(fleet-core/tau), shared by both. It is a package of its own so that neither
end imports the other.

## Provides

`fleet-protocol/tau`:
- `PROTOCOL_VERSION`, which the service checks in every request;
- `socketPath(dshHome)`, where the service listens: `<dshHome>/fleet/tau.sock`;
- the types `Request`, `Response`, `Created` and `Values`.

## Design

A client connects to the socket and sends one request, as one line of JSON.
The service answers with one line of JSON and ends the connection.

- client to service:
  - `{ "protocol": 1, "op": "create", "tauDir": "/…", "callerCwd": "/…", "values": { … } }`
  - `{ "protocol": 1, "op": "start" | "stop" | "delete", "sessionId": "session-…" }`
- service to client:
  - `{ "ok": true, "value": { "sessionId": "session-…", "box": "fleet-tau-…", "prompt": "…" } }` for `create`
  - `{ "ok": true, "value": null }` for the other ops
  - `{ "ok": false, "error": "…" }`

Paths are absolute. `values` are a run's values as tau's docs/spec/values.md
has them, which the service checks against the tau.

## Built on

Node alone.
