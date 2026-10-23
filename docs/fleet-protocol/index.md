# fleet-protocol

The tau service's own requests (fleet-core/tau), beside a run's, shared by
`fleet` (fleet-client) and the service. It is a package of its own so that
neither end imports the other. A run's requests, `submit`, `status`,
`result`, `trace` and `release`, are tau's fleet adaptor's, as tau's
docs/spec/fleet.md has them, with the socket they travel on.

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
| `{ "op": "list" }` | for each run the caller reaches, oldest first, `{ "sessionId", "parent"?, "title", "project", "prompt", "state": "running" \| "ended" \| "finished", "createdAt", "endedAt"?, "result"? }`; `parent`, the run that started it, if one did; `prompt`, the tau's, expanded with where the box has each file; `finished`, once its result was first given back |

A run's id is its session's. Where one run is, and what its agent did,
are tau's `status` and `trace`. A request names no path of the caller's.

## Built on

Node alone.
