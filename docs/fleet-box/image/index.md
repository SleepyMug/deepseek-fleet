# fleet-box/image

Builds the box image: a Node base image with fleet-box, the helper's
package, on top; and stages a package as installed, which the image takes
fleet-box by, and the gateway each service's package
(docs/fleet/services/index.md).

## Provides

- `buildImage({ docker?, tag? })` (`@sleepymug/fleet-box/image/build`), which
  builds the image and tags it `fleet:local` by default; `fleet image build
  [<tag>]` (docs/fleet/cli/index.md) runs it, and `pnpm image [<tag>]` at the
  workspace root builds the workspace first, then runs it.
- `stagePackage(root, target, arch)` (`@sleepymug/fleet-box/image/stage`),
  which copies the package at `root` to `target`, and every package it
  depends on, as installed, to `target/node_modules`.
- `@sleepymug/fleet-protocol/layout`, where things lie in a box, which the
  gateway, the image and the services agree on: fleet-box at `/opt/fleet`, the
  helper's Node and entry, the services' folders and sockets, and the
  default tag. It holds constants only.

## Design

- The package goes into the image as it would be packed, with every package
  it depends on as installed on the host (`stage.ts`). Nothing is installed
  or compiled in the image, so it runs exactly what was built and installed
  on the host.
  - A package from a registry is copied as installed. A workspace or linked
    package is copied as `pnpm pack` would pack it, from its `files`.
  - The copy takes pnpm's layout: the package at `/opt/fleet`, each
    dependency once under `node_modules/.store/<name>@<version>`, and links
    for what each package declares. So every package gets the same instances
    it gets on the host, and nothing else.
  - fleet-box depends on what it runs in the box, dsh's local file system,
    `@deepseek-ai/dsh-fs-local`, with `@deepseek-ai/dsh-fs` and
    `@deepseek-ai/cordis`, and `node-pty`, as packages of its own, so the
    image needs no dsh: a dependency not installed fails the build, saying
    so.
  - The host's package manager chose platform-specific packages for the
    host, so the image must be linux on the host's architecture. Optional
    dependencies for other platforms are left out.
- The image has no command of its own (`ENTRYPOINT []`). The gateway decides
  what runs in a box: `sleep infinity` to keep it up, and the helper and
  what its clients pipe through `docker exec`.
- The services' packages are no part of the image: the gateway copies them
  into each box as it starts, so a service registered later reaches the
  boxes without a new image.

## Built on

- The Docker CLI: `docker version` for the server's architecture, and
  `docker build` on a build context staged in a temporary folder. The folder
  holds the package's `Dockerfile` and, under `fleet/`, the package with its
  dependencies.
- `--provenance=false`, so an unchanged build keeps its image id.

## How it runs

Run `pnpm image` after changing anything that goes into the image. A box
whose image is older than the gateway's helper protocol refuses to start, and
says that a new box gets the current image.

The command builds from fleet-box as installed beside fleet, so it runs from
the install the gateway runs: after `npm install --global @sleepymug/fleet`,
`fleet image build` (docs/install.md).

Not yet: a build is tagged without checking its helper first.
