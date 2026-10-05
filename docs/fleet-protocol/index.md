# fleet-protocol

The wire between `fleet` (fleet-client) and the tau service in the fleet host
(fleet-core/tau), shared by both. It is a package of its own so that neither
end imports the other.

## Provides

`fleet-protocol/tau`:
- `PROTOCOL_VERSION`, which the service checks in every request;
- `socketPath(dshHome)`, where the service listens: `<dshHome>/fleet/tau.sock`;
- the types `Request`, `Response`, `Answers`, `Started`, `Finished`,
  `RunStatus`, `RunState`, `Result` and `Targets`.

## Design

A client connects to the socket and sends one request, as one line of JSON.
The service answers with one line of JSON and ends the connection. A
`start`'s request is followed by the run's call, and a `finish`'s answer by
the run's result: archives of tau's docs/spec/serialization.md, each up to
the end of what its side sends, so the client ends what it sends after the
call.

- client to service:
  - `{ "protocol": 1, "op": "start", "title": "…", "project": "/…", "targets": { "/report": "/…" } }`,
    then the call, which carries the tau
  - `{ "protocol": 1, "op": "list" }`
  - `{ "protocol": 1, "op": "finish", "sessionId": "session-…", "history"?: true }`
  - `{ "protocol": 1, "op": "status" | "cancel" | "delete", "sessionId": "session-…" }`
- service to client, `{ "ok": true, "value": … }` with what the op answers
  (`Answers`), or `{ "ok": false, "error": "…" }`:

  | Op | Value |
  |---|---|
  | `start` | `{ "sessionId": "session-…", "box": "fleet-tau-…", "prompt": "…" }` |
  | `list` | a run's status, as `status` answers, for each run |
  | `status` | `{ "sessionId", "parent"?, "title", "project", "state": "running" \| "ended" \| "finished", "createdAt", "endedAt"?, "result"? }`; `parent`, the run that started it, if one did |
  | `finish` | `{ "result": { "ok": true \| false, "text": "…", "failure"?: "…" }, "targets": { … }, "history"?: [ … ] }`, then the result; `history`, when the request asked for it, the run's session's events, as dsh logs them |
  | `cancel`, `delete` | `null` |

A `finish` answers once the run ends, however long that takes; a client
that closes its connection first gives up the wait, not the run. Its
`history` is in its line, not after it, so the result stays all that
follows; it is no part of tau's spec, and has the form dsh gives it.

Paths are absolute. The call holds the run, tau and all; the line holds
only what a call does not: `title` names the run, in `list` and dsh's web
UI, as `fleet` gives it the name of the tau's directory; `project`
identifies the project, in dsh the folder whose workspace the run's session
is in; `targets` are where the caller has each
`$out` and `$inout` handle, by its JSON Pointer into the values, as tau's
`packCall` gives them. The service keeps them without reading them, and
gives them back with the result, for the caller to put what the run gave
back there: the caller trusts the service as to what goes where. The service
reads no path a caller names, but the project's, to find its workspace.

## Built on

Node alone.
