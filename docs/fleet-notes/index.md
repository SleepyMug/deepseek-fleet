# fleet-notes

A service of fleet's gateway (docs/fleet/services/index.md), and the example
of one: a notebook of short notes, each with tags to find it by later. Each
box has a notebook of its own, which fleet-notes keeps on the host, a file
in its folder, so the notes outlast the box's processes and the service's;
a box made later, such as a later run's, has a notebook of its own.

## Provides

Two packages:

| Package | | |
|---|---|---|
| `@sleepymug/fleet-notes` | `services/notes` | The fleet server: the command `fleet-notes [--dir <dir>]`, which registers the service `notes` with the gateway, at `$FLEET_SOCKET`, or `fleet.sock` in the fleet home, and serves it until interrupted, each box's notebook in `<dir>`, by default `notes/` in the fleet home, as `<box>.json`; and `@sleepymug/fleet-notes/service`, `notesService(notebooks)`, the service as fleet-sdk's `register` takes it. |
| `@sleepymug/fleet-notes-box` | `services/notes/box` | What the gateway puts in each box: the command `notes`; and `@sleepymug/fleet-notes-box/wire`, the wire's types, which both import. |

```
notes add <text> [--tag <tag>]...   keep a note, and print it as JSON
notes tag <tag>                     print the notes with the tag, oldest first, as a JSON list
```

A note is `{ id, text, tags, written }`: its number, which no other note of
its notebook has, what it says, its tags, and when it was kept, as an ISO
date. `notes` exits with 0 once it printed the answer, 1 when the service
fails or cannot be reached, and 2 on a mistaken command line, with its
usage.

## Design

- **The wire.** `notes` opens the service's socket in the box,
  `$FLEET_SERVICES/notes.sock`, sends one line of JSON, `{ "op": "add",
  "text", "tags" }` or `{ "op": "tag", "tag" }`, and ends what it sends;
  fleet-notes answers with one line, `{ "ok": true, "value" }` or
  `{ "ok": false, "error" }`, and closes. The gateway relays both, saying
  first which box the connection comes from.
- **A box's notebook** is named by the box's id, as the gateway says it,
  never as the box does, so a box reaches only its own. A notebook is
  written whole, or not at all.
- **What a box sends is checked:** a text that is not a string, tags that
  are not a list of strings, an op that is none, and a notebook's name that
  is no file's, are refused, saying why.

## Built on

- `@sleepymug/fleet-sdk`'s `register`, for the service.
- Node alone, for `notes`, which imports nothing but its own files.

## How it runs

With `fleet serve` running, `fleet-notes` registers the service, and every
box has the command:

```
$ fleet-notes &
fleet-notes: registered the notes service
```

Then a run of `examples/notebook`, with dsh-tau (docs/dsh-tau/index.md),
saves a list as notes, and reports those with a tag:

```
$ tau run --adaptor socket <checkout>/examples/notebook --call-json '{"files": {"list": "list.txt", "report": "out/report.txt"}, "args": {"tag": "shop"}}'
```

In the box, the agent runs it:

```
# notes add 'buy milk' --tag shop
{"id":1,"text":"buy milk","tags":["shop"],"written":"2026-11-10T09:12:03.512Z"}
# notes tag shop
[{"id":1,"text":"buy milk","tags":["shop"],"written":"2026-11-10T09:12:03.512Z"}]
```
