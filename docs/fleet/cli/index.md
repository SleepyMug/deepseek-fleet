# fleet/cli

`fleet`, the gateway's command: `fleet serve` runs the gateway
(docs/fleet/index.md); the others are its clients, which show its boxes and
services, make and remove boxes, and send methods to a box's helper by
hand; and `fleet image build` builds the box image.

## Provides

```
fleet serve [--image <image>] [--idle-stop <ms>]
                              run the gateway, until interrupted
fleet box list [--json]       list the boxes: id, state, labels
fleet box create [--image <image>] [--label <key>=<value>]... [--service <name>]...
                              make a box, stopped, and print its id
fleet box rm <box>...         remove boxes, running or not
fleet box repl <box>          send methods to a box's helper from a REPL, the box
                              occupied, and started, until the REPL is left
fleet service list [--json]   list the services: name, commands, what each is
fleet image build [<tag>]     build the box image, fleet:local by default, from
                              fleet-box as installed
```

- The gateway's home is `$FLEET_HOME`, or `~/.fleet`; its socket
  `$FLEET_SOCKET`, or `fleet.sock` in its home.
- `serve` makes each box without an image of its own from `--image`, and
  stops each nothing occupies after `--idle-stop` milliseconds, 60 000 by
  default. It runs until SIGINT or SIGTERM, then stops the boxes it started.
- `box create` gives the box its labels, and, with `--service`, the services
  it has; without any, it has every one registered
  (docs/fleet/services/index.md).
- `--json` prints what the gateway answers, as JSON, in place of the table.
- Exit codes:
  - `0` on success;
  - `1` when an operation fails, or no gateway answers on the socket;
  - `2` on a mistaken command line, with a pointer to `--help`.

## The REPL

`box repl` leases the box, which starts it, and reads one line at a time:

- `<method> [<params as a JSON object>]` sends a method to the box's helper,
  through the gateway, such as `echo {"text":"hi"}` or
  `exec {"argv":["ls","/"]}`. The result is printed as one line of JSON on
  stdout. Errors go to stderr as `error: …`; the gateway refuses a method
  its boxes do not take, and the gateway's own, `hello` and `services.*`.
- `.help` lists the methods and commands. `.exit` leaves.
- Ctrl+D on an empty line types `.exit`, which waits behind a request in
  progress. Ctrl+C leaves at once.
- Leaving the REPL releases the lease: the box stops once it has been idle
  long enough.

On a terminal, the REPL has a prompt, line editing and tab completion. With
piped input, it prints no prompt, so a script gets results alone on stdout.

## Built on

- `FleetGateway` and its socket, for `serve`; `@sleepymug/fleet-sdk`, for
  the others (docs/fleet-sdk/index.md).
- `@sleepymug/fleet-box/image/build`, for `image build`
  (docs/fleet-box/image/index.md).
- `node:util`'s `parseArgs`, for the command line, and `node:readline`, for
  the REPL (`repl.ts`).

## How it runs

After `pnpm build` and `pnpm image`, with `fleet serve` running:

```
$ alias fleet='node packages/fleet/lib/cli/main.js'
$ fleet box create --label who=me
box-1f0c6a52e9b4d873
$ fleet box list
BOX                   STATE    LABELS
box-1f0c6a52e9b4d873  stopped  who=me
$ fleet box repl box-1f0c6a52e9b4d873
fleet: box-1f0c6a52e9b4d873 started; .help lists what to send
box-1f0c6a52e9b4d873> echo {"text":"hi"}
{"text":"hi"}
box-1f0c6a52e9b4d873> .exit
$ printf 'exec {"argv":["ls","/opt/fleet/bin"]}\n' | fleet box repl box-1f0c6a52e9b4d873 2>/dev/null
{"code":0,"signal":null,"stdout":"notes\ntau\n","stderr":""}
$ fleet service list
SERVICE  COMMANDS  WHAT IT IS
notes    notes     A notebook of short notes, each with tags to find it by later, …
tau      tau       Runs TAUs, each in a box of its own, as this box's run, …
$ fleet box rm box-1f0c6a52e9b4d873
```
