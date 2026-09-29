# Session image for fleet-box, as `fleet-setup image` builds it outside dsh:
# an environment for the model's commands, with fleet's runtime installed on
# top: fleet-box's helper, which serves each session's files and processes
# from inside its container, and fleet-tau's TypeScript runner, which runs
# the model's programs there. The environment is the `environment` stage
# below unless `--from` names an image, which the ENVIRONMENT build arg
# puts in its place. The build context holds only a folder per part
# (src/image.ts): its manifest, lockfile and tsconfig, its tarballs in
# vendor/, and its sources in src/.

ARG ENVIRONMENT=environment

# The helper: compiled from its sources, then kept with only its runtime
# dependencies and a copy of Node under a name of its own.
FROM node:26.9.0-trixie-slim AS helper
WORKDIR /build
COPY helper/package.json helper/npm-shrinkwrap.json ./
RUN npm ci --no-audit --no-fund --no-update-notifier
COPY helper/tsconfig.json ./
COPY helper/src/ src/
RUN npx tsc -p tsconfig.json \
 && npm prune --omit=dev --no-audit --no-fund --no-update-notifier \
 && mkdir -p /opt/fleet-box/bin /opt/fleet-box/helper \
 && cp /usr/local/bin/node /opt/fleet-box/bin/fleet-box \
 && cp -r package.json node_modules dist/. /opt/fleet-box/helper/

# The TypeScript runner: ts-executor, which type-checks and runs programs,
# and the runner that drives it, kept with only their runtime dependencies.
# They run on the helper's Node.
FROM node:26.9.0-trixie-slim AS runner
WORKDIR /build
COPY runner/package.json runner/npm-shrinkwrap.json ./
COPY runner/vendor/ vendor/
RUN npm ci --no-audit --no-fund --no-update-notifier
COPY runner/tsconfig.json ./
COPY runner/src/ src/
RUN npx tsc -p tsconfig.json \
 && npm prune --omit=dev --no-audit --no-fund --no-update-notifier \
 && mkdir -p /opt/fleet/runner \
 && cp -r package.json node_modules dist/. /opt/fleet/runner/

# The default environment: a Debian toolchain for the model's commands.
FROM node:26.9.0-trixie-slim AS environment
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl git less procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

FROM ${ENVIRONMENT}
COPY --from=helper /opt/fleet-box /opt/fleet-box
COPY --from=runner /opt/fleet/runner /opt/fleet/runner
# fleet-box runs `sleep infinity` as root in every container, whatever the environment set.
USER root
ENTRYPOINT []
