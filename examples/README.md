# Example agents

Agent directories in the tau format (../../agent_fleet_project/tau/SPEC.md), for trying `fleet run`:

| Agent | Shows | Try |
|---|---|---|
| `hello` | arguments, a skill | `fleet run examples/hello World "and everyone else"` |
| `skilled` | a skill with a script, run from the session's container | `fleet run examples/skilled "one two three"` |
| `notes` | a service, called from a TypeScript program; its manifest links to the example provider's, which fleet-tau's patch lists disabled | `fleet check examples/notes`, then `fleet run examples/notes "buy milk" shopping,errands` |
| `text-stats` | a module a TypeScript program imports | `fleet run examples/text-stats "the cat and the hat and the bat"` |
| `count-words` | a read-only input file and a copy-out report, outside the session folder, and a variable from the caller | `fleet run --cwd <folder> examples/count-words <file> <report>`, with both paths outside `<folder>` |
