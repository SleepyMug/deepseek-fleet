# fleet-protocol

The wire between `fleet` (fleet-client) and the tau service in the fleet host
(fleet-core/tau), shared by both. It is a package of its own so that neither
end imports the other.

## Provides

`fleet-protocol/tau`:
- `PROTOCOL_VERSION`, which the service checks in every request;
- `socketPath(dshHome)`, where the service listens: `<dshHome>/fleet/tau.sock`;
- the types `Request`, `Response`, `Answers`, `Started`, `RunStatus`,
  `RunState`, `Result` and `Values`.

## Design

A client connects to the socket and sends one request, as one line of JSON.
The service answers with one line of JSON and ends the connection.

- client to service:
  - `{ "protocol": 1, "op": "start", "tauDir": "/…", "callerCwd": "/…", "values": { … } }`
  - `{ "protocol": 1, "op": "list" }`
  - `{ "protocol": 1, "op": "status" | "finish" | "cancel" | "delete", "sessionId": "session-…" }`
- service to client, `{ "ok": true, "value": … }` with what the op answers
  (`Answers`), or `{ "ok": false, "error": "…" }`:

  | Op | Value |
  |---|---|
  | `start` | `{ "sessionId": "session-…", "box": "fleet-tau-…", "prompt": "…" }` |
  | `list` | a run's status, as `status` answers, for each run |
  | `status` | `{ "sessionId", "tauDir", "project", "state": "running" \| "ended" \| "finished", "createdAt", "endedAt"?, "result"? }` |
  | `finish` | `{ "ok": true \| false, "text": "…", "failure"?: "…" }`, tau's result |
  | `cancel`, `delete` | `null` |

A `finish` answers once the run ends, however long that takes; a client
that closes its connection first gives up the wait, not the run.

Paths are absolute. `values` are a run's values as tau's docs/spec/values.md
has them, which the service checks against the tau.

## Built on

Node alone.
