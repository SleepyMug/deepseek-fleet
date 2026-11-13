# fleet-box/image

Builds the box image: a Node base image with fleet-box, the helper's
package, on top, staged as installed (docs/fleet-pack/index.md). The image
holds the helper alone: what a box's services bring, their clients, what
those import, and their packages, the gateway installs in each box as it
first starts (docs/fleet/services/index.md), so a new service, or a new
client generator, needs no new image.

## Provides

- `buildImage({ docker?, tag? })` (`@sleepymug/fleet-box/image/build`), which
  builds the image and tags it `fleet:local` by default; `fleet image build
  [<tag>]` (docs/fleet/cli/index.md) runs it, and `pnpm image [<tag>]` at
  the workspace root builds the workspace first, then runs it.

## Design

- The package goes into the image as it would be packed, with every package
  it depends on as installed on the host, in pnpm's layout (fleet-pack's
  `stagePackage`): nothing is installed or compiled in the image, so it runs
  exactly what was built and installed on the host, which must be linux on
  the Docker server's architecture.
- The image has no command of its own (`ENTRYPOINT []`): the gateway's
  driver runs the helper as each box's command.

## Built on

- The Docker CLI: `docker version` for the server's architecture, and
  `docker build` on a build context staged in a temporary folder, holding
  the package's `Dockerfile` and, under `fleet/`, the package with its
  dependencies; `--provenance=false`, so an unchanged build keeps its id.

## How it runs

Run `pnpm image` after changing anything that goes into the image. A box
whose helper speaks another version of its tunnel than the gateway is
refused as it dials in, and says that a new box gets the current image.
