# fleet-core/tau

The tau service. It sets up a box for a run of a tau, keeps which box each
session has, and starts, stops and deletes the box. It runs in dsh's process,
in the fleet profile, but uses nothing of dsh's. It creates no dsh session
yet: `create` mints the session's id and expands the prompt the session will
be given.

## Provides

`fleet-tau` (`fleet-core/tau/plugin`), a dsh plugin, which fleet-core's
`cordis.patch.yml` mounts. It serves `fleet-protocol/tau` on
`$DSH_HOME/fleet/tau.sock`, for `fleet` (fleet-client):

| Op | What it does |
|---|---|
| `create { tauDir, callerCwd, values }` | Set up a box for a run of the tau with the values, leave it stopped, and register the session. Answers `{ sessionId, box, prompt }`. |
| `start { sessionId }` | Start the session's box, and its helper. |
| `stop { sessionId }` | Stop the session's box, which keeps what is in it. |
| `delete { sessionId }` | Remove the session's box, running or not, and forget the session. |

## Design

- **`create`** goes in this order:
  1. It reads the tau and binds the values with tau's library:
     `loadTau(tauDir).bind(values, { cwd: callerCwd }, place, '/tau/self')`
     checks the values against `tau.json`, places each handle, and expands
     `PROMPT.md` with the places. `checkInputs` then checks the caller's
     paths. Nothing is made before these pass.
  2. It mints `session-<uuid>`, the form dsh's session ids take, so that a
     dsh session can have it later.
  3. It creates the box `fleet-tau-<uuid>`, starts it, makes its folders
     with the helper's `exec` (`mkdir -p`), copies in the tau and each `$in`
     and `$inout` handle, and stops it.
  4. It writes the registry entry.

  A failure in 3 or 4 removes the box.
- **Places** (`place.ts`), each under the base name of the caller's path:

  | What | Where in the box |
  |---|---|
  | an `$in` handle | `/tau/in/<base name>` |
  | an `$inout` handle | `/tau/workspace/<base name>` |
  | an `$out` handle | `/tau/out/<base name>` |
  | the tau's own directory, `${self}` | `/tau/self` |

  A base name already taken in its folder gets a suffix in its stem:
  `notes.md`, `notes-1.md`, `notes-2.md`. An `$out` handle is not copied
  in. Its folder is made for a `dir`, and only its parent for a `file` or a
  `path`, since the agent makes what it leaves.
- **The registry** (`registry.ts`) has one JSON file per session,
  `$DSH_HOME/fleet/taus/<session id>.json`: the box, the tau, the expanded
  prompt, each handle (its mode, kind, caller's path and place), the names
  of the APIs the tau declares, and when it was made. An entry is written
  last, so an entry means a box that is set up. A service started later
  finds its sessions there. Only ids of the form the service mints name an
  entry, since they are file names.
- **One `Box` per session.** The service opens each session's box once and
  keeps it, so the box's verbs run in order. When the plugin unloads, as dsh
  exits, it stops the boxes it started.
- **Deleting** a session whose box was removed by other means still forgets
  the session.
- **The socket** (`server.ts`) has mode 0600, and its folder is made with
  mode 0700, so only the owner can open it. That is its authentication, as
  it is for the dsh home's own files. It takes one request per connection:
  one line of JSON in, one out. A socket a service answers on is not taken
  over; one left by a service that died is.
- **Printing.** The service prints what it does, the expanded prompt
  included, on dsh's stderr, after `fleet-tau:`. dsh's logger shows no info.
- **Nothing of dsh's.** The plugin injects no service and imports no dsh
  package. Its config gives it the dsh home, as `dshHomePath()` in the patch.

## Not yet

- `start` creates no dsh session, and sends the prompt nowhere.
- The APIs are only listed in the registry entry; nothing implements them.
- Nothing comes back out: `$out` and `$inout` handles are neither copied back
  nor checked with `checkOutputs`.
- A box left by a dsh that died during `create` stays. `fleet-box list` shows
  it as `fleet-tau-…`, and `fleet-box delete` removes it.

## Built on

- `@sleepymug/tau`: `loadTau`, `bind`, `checkInputs`.
- `Box` and `exec` (`fleet-core/box`).
- `fleet-protocol/tau`, for the wire.

## How it runs

The fleet profile lists fleet-core after dsh's base and web bundles, beside
fleet-profile (docs/fleet-profile/index.md); the service needs only
fleet-core.

After `pnpm build` and `pnpm image`, `pnpm exec dsh --profile fleet`, with
the dsh the workspace pins, starts the service with the web host, and
`fleet` talks to it
(docs/fleet-client/index.md). On dsh's stderr:

```
fleet-tau: created session-4a65… in box fleet-tau-4a65…, with the prompt:
Read /tau/in/notes.md, and add what it says to the pages in /tau/workspace/site it concerns, in a
terse style. Then write what you changed to /tau/out/report.md.
fleet-tau: deleted session-4a65… and its box fleet-tau-4a65…
```
