# Session image for fleet-box, as `fleet setup image` (fleet-client) builds
# it outside dsh: an environment for the model's commands, with fleet's
# runtime on top, this package: fleet-box's helper, which serves each
# session's files and processes from inside its container, fleet-tau's
# TypeScript runner, which runs the model's programs there, and fleet's
# implementations of the APIs those programs import. The environment is the
# `environment` stage below unless `--from` names an image, which the
# ENVIRONMENT build arg puts in its place. The build context's fleet/ holds
# this package, compiled into lib/, with every package it depends on as
# installed on the host, so nothing is installed or compiled here. The
# folders are src/layout.ts's: `fleet setup image` checks the helper, the
# runner and the implementations where the host will look for them before
# it tags a build.

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
COPY --from=node /usr/local/bin/node /opt/fleet/bin/fleet-node
# This package's lib/ at the top of /opt/fleet (PACKAGE_ROOT), beside its package.json
# and node_modules: helper/, runner/ and apis/.
COPY fleet/package.json /opt/fleet/
COPY fleet/node_modules/ /opt/fleet/node_modules/
COPY fleet/lib/ /opt/fleet/
# fleet-box runs `sleep infinity` as root in every container, whatever the environment set.
USER root
ENTRYPOINT []
