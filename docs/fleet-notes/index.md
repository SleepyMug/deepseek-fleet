# fleet-notes

A service of fleet's gateway (docs/fleet/services/index.md), and the
example of one: a notebook of short notes, each with tags to find it by
later. Each box made with it has a notebook of its own, which fleet-notes
keeps where it runs, a file in its folder, so the notes outlast the box's
processes and the service's; a box made later has a notebook of its own.
It is a schema and a server alone: a box's programs use its client.

## Provides

`@sleepymug/fleet-notes` (`services/notes`):

- `proto/notes/v1/notes.proto`, `notes.v1.Notes`: `Add { text, tags }`,
  which keeps a note and answers it, `{ id, text, tags, written }`, its
  number, which no other note of its notebook has, what it says, its tags,
  and when it was kept; and `Tagged { tag }`, the notes with the tag, oldest
  first.
- The command `fleet-notes [--dir <dir>]`, which serves the service to the
  gateway at `$FLEET_SOCKET`, or `fleet.sock` in the fleet home, until
  interrupted, each box's notebook in `<dir>`, by default `notes/` in the
  fleet home, as `<box>.json`.
- `@sleepymug/fleet-notes/service`: `notesService(notebooks)`, the service as
  fleet-sdk's `serve` takes it.

## Design

- **A box's notebook** is named by the box's id, as the gateway says it
  (fleet-sdk's `boxOf`), never as the box does, so a box reaches only its
  own; a call from a client, not a box, is refused. A notebook is written
  whole, or not at all.
- **Its schema** is generated with `pnpm gen`: its code in `src/gen`, and
  the schema itself, with its comments, as `src/gen/descriptors.ts`, which
  it stages.

## Built on

- `@sleepymug/fleet-sdk`'s `serve` and `boxOf`.

## How it runs

With `fleet serve` running, `fleet-notes` registers the service, and a box
made with it, `fleet box create --service notes`, has its client. In the
box, `fleet box sh <box>`:

```
# mkdir -p /fleet/programs && cat > /fleet/programs/shop.mts
import { notes } from '@fleet/notes'
await notes.add({ text: 'buy milk', tags: ['shop'] })
console.log((await notes.tagged({ tag: 'shop' })).notes.map(note => note.text))
^D
# node /fleet/programs/shop.mts
[ 'buy milk' ]
# curl -s --unix-socket /run/fleet/services.sock -H 'content-type: application/json' -d '{"tag":"shop"}' http://fleet/services/notes/notes.v1.Notes/Tagged
{"notes":[{"id":1,"text":"buy milk","tags":["shop"],"written":"2026-11-13T06:12:53.918Z"}]}
```
