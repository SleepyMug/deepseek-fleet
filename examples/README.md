# Example agents

Agent directories in the tau format (../../agent_fleet_project/tau/SPEC.md), for trying `fleet run`:

| Agent | Shows | Try |
|---|---|---|
| `hello` | arguments, a skill | `fleet run examples/hello World "and everyone else"` |
| `skilled` | a skill with a script, run from the session's container | `fleet run examples/skilled "one two three"` |
| `notes` | an API whose implementation keeps its notes on the fleet host, and gives back dates as dates | `fleet check examples/notes`, then `fleet run examples/notes "buy milk" shopping,errands` |
| `text-stats` | an API whose implementation runs in the program alone | `fleet run examples/text-stats "the cat and the hat and the bat"` |
| `count-words` | an `in` file and an `out` report, and a variable from the caller | `fleet run examples/count-words <file> <report>` |
| `archive-dir` | an API that takes a folder, which its implementation packs with tar and sends to the fleet host | `fleet check examples/archive-dir`, then `fleet run examples/archive-dir <dir>` |
| `count-each` | the `tau` API: an agent the tau carries, which its prompt names with `${self}`, run once per file as runs of their own, which give back their outputs | `fleet run examples/count-each <dir> <summary>` |

A tau declares its APIs, and fleet links each to its own implementation of the same name, which
the session image carries (packages/fleet-image/src/apis); `fleet apis` lists them, and `fleet apis <name>`
prints the declarations an agent's `api/<name>.d.ts` can copy, as these examples' do. Those of
`notes` and `archives` call backends on the fleet host, which fleet-core's patch lists disabled:
enable `fleet-tau-notes` and `fleet-tau-archives` to run them. The `tau` API's backend is always on:
an agent that declares it runs other taus, from a program or with the `tau` command in its container,
each as a subagent of its own, which takes no `share` path.

tau is a compiled format, whose symlinks stay inside the agent directory, and its source format is
still to come. So until then, an example that needs what another has, or one of fleet's own, holds
a copy of it rather than a link.
