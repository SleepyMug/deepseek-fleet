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
| `word-report` | a package of the agent's own, built on the `text-stats` API, which its programs are given in the API's place (`exposes`) | `fleet run examples/word-report "the cat and the hat and the bat"` |
| `count-each` | the `tau` API: an agent the tau carries, which its prompt names with `${self}`, run once per file as runs of their own, which give back their outputs; and paths at places of its own choosing, `at` | `fleet run examples/count-each <dir> <summary>` |

A tau declares its APIs, and fleet links each to its own implementation of the same name, which
the session image carries (packages/fleet-image/src/apis); `fleet apis` lists them, and `fleet apis <name>`
prints the declarations an agent's `api/<name>.d.ts` can copy, as these examples' do. Those of
`notes` and `archives` call backends on the fleet host, which fleet-core's patch lists disabled:
enable `fleet-tau-notes` and `fleet-tau-archives` to run them. The `tau` API's backend is always on:
an agent that declares it runs other taus, from a program or with the `tau` command in its container,
each as a subagent of its own. A session not started from an agent directory, one the web UI starts
or `fleet run -p`, has the `tau` API without declaring it, so it can run these examples itself, from
its project in its container, as `tau run examples/hello World ""`.

An agent may also carry packages of its own in `node_modules/`, built on its APIs, and give its
programs those rather than the APIs, as `word-report` does with tau.json's `exposes`. fleet links
each API in the node_modules folder above the agent's snapshot in the container, so a package
imports the implementation a program would.

tau is a compiled format, whose symlinks stay inside the agent directory, and its source format is
still to come. So until then, an example that needs what another has, or one of fleet's own, holds
a copy of it rather than a link.
