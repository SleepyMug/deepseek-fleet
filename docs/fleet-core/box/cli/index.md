# fleet-core/box/cli

`fleet-box`, a command to show a box and debug it and its helper by hand.

## Provides

```
fleet-box create [--image <image>] [--name <name>]   create a box, stopped, and print its name
fleet-box list                                       list the boxes
fleet-box delete <name>...                           remove boxes, running or not
fleet-box copy-in <name> <from> <to>                 copy a host folder's contents into the box
fleet-box copy-out <name> <from> <to>                copy a box folder's contents out to the host
fleet-box start <name>                               start the box, and send methods from a REPL
```

- Every command but `create` and `list` opens an existing box by name.
- Exit codes:
  - `0` on success;
  - `1` when an operation fails;
  - `2` on a mistaken command line, with a pointer to `--help`.

## The REPL

`start` starts the box and reads one line at a time:

- `<method> [<params as a JSON object>]` sends a method, such as
  `echo {"text":"hi"}`. The result is printed as one line of JSON on stdout.
  Errors go to stderr as `error: …`.
- `.help` lists the methods and commands. `.exit` leaves.
- Ctrl+D on an empty line types `.exit`, which waits behind a request in
  progress. Ctrl+C leaves at once.
- Leaving the REPL stops the box.

On a terminal, the REPL has a prompt, line editing and tab completion. With
piped input, it prints no prompt, so a script gets results alone on stdout.

## Built on

- `Box` (`fleet-core/box`), for every command.
- `node:util`'s `parseArgs`, for the command line.
- `node:readline`, for the REPL (`repl.ts`).

## How it runs

After `pnpm build` and `pnpm image`:

```
$ alias fleet-box='node packages/fleet-core/lib/box/cli/main.js'
$ fleet-box create --name demo
demo
$ fleet-box copy-in demo ./notes /data
$ fleet-box start demo
fleet-box: demo started; .help lists what to send
demo> echo {"text":"hi"}
{"text":"hi"}
demo> .exit
fleet-box: demo stopped
$ printf 'echo {"text":"again"}\n' | fleet-box start demo 2>/dev/null
{"text":"again"}
$ fleet-box delete demo
```
