# Session image for fleet-box, as `fleet-setup image` builds it outside dsh:
# an environment for the model's commands, with fleet's runtime on top:
# fleet-box's helper, which serves each session's files and processes from
# inside its container, fleet-tau's TypeScript runner, which runs the
# model's programs there, and fleet's implementations of the APIs those
# programs import (fleet-apis). The environment is the `environment` stage below
# unless `--from` names an image, which the ENVIRONMENT build arg puts in
# its place. The build context holds a folder per part (src/image.ts): its
# package, compiled into lib/, with every package it depends on as
# installed on the host (src/stage.ts), so nothing is installed or compiled
# here.

# The Node image the default environment builds on, whose Node the helper and the runner run on.
ARG NODE_IMAGE=node:26.9.0-trixie-slim
ARG ENVIRONMENT=environment

FROM ${NODE_IMAGE} AS node

# The default environment: a Debian toolchain for the model's commands, and
# for fleet's API implementations, such as the tar that `archives` runs.
FROM ${NODE_IMAGE} AS environment
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl git less procps ripgrep tar \
 && rm -rf /var/lib/apt/lists/*

FROM ${ENVIRONMENT}
# The helper's own copy of Node, under a name of its own; the runner runs on it too.
COPY --from=node /usr/local/bin/node /opt/fleet-box/bin/fleet-box
# Each part's lib/ at the top of its folder, beside its package.json and node_modules.
COPY helper/package.json /opt/fleet-box/helper/
COPY helper/node_modules/ /opt/fleet-box/helper/node_modules/
COPY helper/lib/ /opt/fleet-box/helper/
COPY runner/package.json /opt/fleet-tau/runner/
COPY runner/node_modules/ /opt/fleet-tau/runner/node_modules/
COPY runner/lib/ /opt/fleet-tau/runner/
COPY apis/package.json /opt/fleet-tau/apis/
COPY apis/node_modules/ /opt/fleet-tau/apis/node_modules/
COPY apis/lib/ /opt/fleet-tau/apis/
# fleet-box runs `sleep infinity` as root in every container, whatever the environment set.
USER root
ENTRYPOINT []
