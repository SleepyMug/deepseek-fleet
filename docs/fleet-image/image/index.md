# fleet-image/image

Builds the box image: a Node base image with fleet's runtime on top.

## Provides

- `buildImage({ docker?, tag? })` (`fleet-image/image/build`), which builds
  the image and tags it `fleet:local` by default. `pnpm image [tag]` at the
  workspace root builds the workspace first, then runs it.
- `fleet-image/layout`, where things lie in the image, which the host and the
  image agree on: the package at `/opt/fleet`, the helper's Node and entry,
  the tau runtime's entry, and the default tag. It holds constants only.
- The tau runtime, the runtime's side of a tau's run in its box, on tau's
  library, which the image holds as a dependency of this package, and which
  owns where a run has its things in its box (`fleet-image/tau/layout`):
  the host runs `node /opt/fleet/lib/tau/main.js setup`, with the run's
  call on stdin, which sets the box up and reports, as JSON, the prompt,
  the handles and where things are; and `… pack '{"outcome"}'`, which
  writes the run's result on stdout, packed from what the agent left at its
  `$out` and `$inout` handles, or a failure, when that does not fit the tau
  (docs/fleet-core/tau/index.md). `fleet-image/tau/endpoint` exports both,
  each with the root the box's paths are under, for tests.

## Design

- The package goes into the image as it would be packed, with every package
  it depends on as installed on the host (`stage.ts`). Nothing is installed
  or compiled in the image, so it runs exactly what the host built and
  installed.
  - A package from a registry is copied as installed. A workspace or linked
    package is copied as `pnpm pack` would pack it, from its `files`.
  - The copy takes pnpm's layout: the package at `/opt/fleet`, each
    dependency once under `node_modules/.store/<name>@<version>`, and links
    for what each package declares. So every package gets the same instances
    it gets on the host, and nothing else.
  - The host's package manager chose platform-specific packages for the
    host, so the image must be linux on the host's architecture. Optional
    dependencies for other platforms are left out.
- The image has no command of its own (`ENTRYPOINT []`). The host decides
  what runs in a box: `sleep infinity` to keep it up, and the helper and the
  tau runtime through `docker exec`.

## Built on

- The Docker CLI: `docker version` for the server's architecture, and
  `docker build` on a build context staged in a temporary folder. The folder
  holds the package's `Dockerfile` and, under `fleet/`, the package with its
  dependencies.
- `--provenance=false`, so an unchanged build keeps its image id.

## How it runs

Run `pnpm image` after changing anything that goes into the image. A box
whose image is older than the host's protocol refuses to start, and says to
rebuild.

Not yet: a build is tagged without checking its helper first.
