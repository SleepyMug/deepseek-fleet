# Session image for fleet-box: a Debian toolchain for the model's commands,
# plus fleet-box's helper, which serves each session's files and processes
# from inside its container, and its TypeScript runner, which runs the
# model's programs there. Build it with `fleet-setup image` before starting
# dsh; its build context is exactly the files imageInputs() lists
# (src/image.ts), relative to the package folder, and its tag is their digest.

# The helper: compiled from its sources, then kept with only its runtime
# dependencies and a copy of Node under a name of its own.
FROM node:26.9.0-trixie-slim AS helper
WORKDIR /build
COPY image/helper/package.json image/helper/npm-shrinkwrap.json ./
RUN npm ci --no-audit --no-fund --no-update-notifier
COPY image/helper/tsconfig.json ./
COPY src/helper/ src/
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
COPY image/runner/package.json image/runner/npm-shrinkwrap.json ./
COPY image/runner/vendor/ vendor/
RUN npm ci --no-audit --no-fund --no-update-notifier
COPY image/runner/tsconfig.json ./
COPY src/runner/ src/
RUN npx tsc -p tsconfig.json \
 && npm prune --omit=dev --no-audit --no-fund --no-update-notifier \
 && mkdir -p /opt/fleet-box/runner \
 && cp -r package.json node_modules dist/. /opt/fleet-box/runner/

FROM node:26.9.0-trixie-slim

RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl git less procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

COPY --from=helper /opt/fleet-box /opt/fleet-box
COPY --from=runner /opt/fleet-box/runner /opt/fleet-box/runner
