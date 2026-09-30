# Example agents

Agent directories in the tau format (../../agent_fleet_project/tau/SPEC.md), for trying `fleet run`:

| Agent | Shows | Try |
|---|---|---|
| `hello` | arguments, a skill | `fleet run examples/hello World "and everyone else"` |
| `skilled` | a skill with a script, run from the session's container | `fleet run examples/skilled "one two three"` |
| `notes` | a service, called from a TypeScript program; its manifest is a copy of the example provider's, which fleet-tau's patch lists disabled | `fleet check examples/notes`, then `fleet run examples/notes "buy milk" shopping,errands` |
| `text-stats` | a module a TypeScript program imports | `fleet run examples/text-stats "the cat and the hat and the bat"` |
| `count-words` | an `in` file and an `out` report, outside the session folder, and a variable from the caller | `fleet run --cwd <folder> examples/count-words <file> <report>`, with both paths outside `<folder>` |
| `archive-dir` | bytes: a module packs an `in` folder with tar and sends the tarball to a service that takes a `Uint8Array`, so the agent sees only the module, which takes a folder; the service's manifest is a copy of the example provider's, which fleet-tau's patch lists disabled | `fleet check examples/archive-dir`, then `fleet run --cwd <folder> examples/archive-dir <dir>`, with `<dir>` outside `<folder>` |

tau is a compiled format, whose symlinks stay inside the agent directory, and its source format is
still to come. So until then, an example that needs a manifest or a module another has, or one of
fleet's own, holds a copy of it rather than a link: `fleet services notes` prints the manifest
`notes` copies.
