# fleet/cli

`fleet`, the gateway's command: `fleet serve` runs the gateway
(docs/fleet/index.md); the others are its clients, which show its boxes and
services, make, start, stop and remove boxes, and run programs and shells
in them; and `fleet image build` builds the box image.

## Provides

```
fleet serve [--image <image>] [--idle-stop <ms>] [--driver docker|local]
                              run the gateway, until interrupted
fleet box list [--json]       list the boxes: id, state, services, labels
fleet box create [--image <image>] [--label <key>=<value>]... [--service <name>]...
                 [--env <name>=<value>]... [--idle-stop <ms>]
                              make a box, stopped, and print its id
fleet box start <box>         start a box, which stops once it is idle
fleet box stop <box>          stop a box
fleet box rm <box>...         remove boxes, running or not
fleet box exec <box> [--cwd <dir>] -- <program> [<arg>...]
                              run a program in a box, and exit as it does
fleet box sh <box> [-- <program> [<arg>...]]
                              a terminal in a box, its shell by default
fleet service list [--json]   list the services: name, commands, what each is
fleet image build [<tag>]     build the box image, fleet:local by default, from
                              fleet-box as installed
```

- The gateway's home is `$FLEET_HOME`, or `~/.fleet`; its clients' socket
  `$FLEET_SOCKET`, or `fleet.sock` in its home.
- `serve` makes each box without an image of its own from `--image`, and
  stops each nothing occupies after `--idle-stop` milliseconds, 60 000 by
  default; `--driver local` makes each box a folder in the home, and its
  helper a process here, which nothing isolates. It runs until SIGINT or
  SIGTERM, then stops the boxes it started.
- `box create` gives the box its labels, its environment, and the services
  it has, each registered now.
- `box exec` and `box sh` hold the box while they run, starting it if it is
  not; `box sh` puts this terminal in raw mode, and follows its size.
- `--json` prints what the gateway answers, as JSON, in place of the table.
- Exit codes: `0` on success, or `box exec`'s and `box sh`'s program's own;
  `1` when an operation fails, or no gateway answers on the socket; `2` on a
  mistaken command line, with a pointer to `--help`.

## Built on

- `FleetGateway` and `serve`, for `serve`; `@sleepymug/fleet-sdk`, for the
  others (docs/fleet-sdk/index.md).
- `@sleepymug/fleet-box/image/build`, for `image build`.
