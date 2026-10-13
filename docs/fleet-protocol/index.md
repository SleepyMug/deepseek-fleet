# fleet-protocol

The tau service's own requests (fleet-core/tau), beside a run's, shared by
`fleet` (fleet-client) and the service. It is a package of its own so that
neither end imports the other. A run's requests, `submit`, `finish` and
`release`, are tau's fleet adaptor's, as tau's docs/spec/fleet.md has
them, with the socket they travel on.

## Provides

`@sleepymug/fleet-protocol/tau`:
- `socketPath(dshHome)`, where the service listens: `<dshHome>/fleet/tau.sock`,
  as tau's `defaultFleetSocket` finds it;
- the types `Request`, `Answers`, `RunStatus`, `RunState` and `Result`.

## Design

A request is a JSON object, its `op` and what it takes, and its answer
JSON, carried as tau's fleet wire carries every request: on the socket,
one line each way, with the wire's version, or through the `tau` API's
extension, from a box (docs/fleet-ext-tau/index.md).

| Request | Answer |
|---|---|
| `{ "op": "list" }` | a run's status, as `status` answers, for each run the caller reaches, oldest first |
| `{ "op": "status", "id": "session-…" }` | `{ "sessionId", "parent"?, "title", "project", "prompt", "state": "running" \| "ended" \| "finished", "createdAt", "endedAt"?, "result"? }`; `parent`, the run that started it, if one did; `prompt`, the tau's, expanded with where the box has each file |
| `{ "op": "history", "id": "session-…" }` | the run's session's events, as dsh logs them, oldest first |

A run's id is its session's. The history is no part of tau's spec, and has
the form dsh gives it. A request names no path of the caller's.

## Built on

Node alone.
