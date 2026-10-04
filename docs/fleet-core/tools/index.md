# fleet-core/tools

The TypeScript tools of a tau's session: `ts_modules` and `ts_execute`. The
model writes a program over what its tau exposes, the tau's APIs and the
packages of its own built on them, and runs it in the session's box. Each
API there runs the client of the extension that implements it
(docs/fleet-core/ext/index.md).

## Provides

`fleet-ts-tools` (`fleet-core/tools/ts`), a dsh plugin that fleet-core's
`tau` agent preset mounts. It registers the two tools, and a system-prompt
section on how to use them:

| Tool | Takes | Gives |
|---|---|---|
| `ts_modules` | `{ query? }` | What a program may import: each `{ specifier, packageRoot, description }`, `packageRoot` the package's folder in the box, whose `package.json` and declarations the model reads. |
| `ts_execute` | `{ source, cwd?, input? }` | `{ value, stdout, stderr, durationMs }`: what the program's `main(input)` returned, and all it wrote. A type error, or the program's failure, is a tool error carrying its name, message, TypeScript's diagnostics or the program's stack, and the output. |

## Design

- **What a program imports** is what the tau exposes, as the session's
  registry entry records it (docs/fleet-core/tau/index.md): `@api/<name>`,
  or a package's name, each with its folder in `/tau/node_modules`, which
  the run linked. `ts_modules` lists them, filtered by the query, from the
  entry, without the box. What is not exposed resolves too, through the
  same folder: exposing is no security boundary.
- **A program runs in the box,** through the helper's `ts.execute`
  (docs/fleet-image/helper/index.md), with ts-executor, which the image
  carries. ts-executor writes the program in a run folder below `/tau`
  (`/tau/.ts-executor/runs/`), so Node finds `/tau/node_modules` above it,
  and TypeScript does too. It type-checks the program, strictly, with each
  API typed by the tau's own declarations and Node's types as the image has
  them, then runs `main(input)` in a fresh Node process, in `cwd`: the
  session's working folder unless the model names another.
- **Cancelling** the tool call sends `ts.cancel`, which ends the program's
  whole process group.
- **No limits** on how long a program runs, or how much it writes and
  returns, as there is none on what bash runs in the foreground; dsh's
  tool-result pruner shortens old results.
- **Only a tau's session** has the tools: the `tau` preset mounts them, and
  a call from another session fails.

## Not yet

- The tools show the whole output and value, however large.
- Nothing presents what a tau exposes before the model calls `ts_modules`;
  the prompt section says to.

## Built on

- `@deepseek-ai/dsh-tools` (`defineTool`) and
  `@deepseek-ai/dsh-system-prompt`, which must be the copies the running
  dsh loaded: run the workspace's dsh, `pnpm exec dsh`.
- `ctx.fleetTauRuns` (fleet-core/tau), for the session's entry and box.
- The helper's `ts.execute` and `ts.cancel`, with `@sleepymug/ts-executor`
  in the image.
