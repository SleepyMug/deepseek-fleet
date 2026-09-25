# Session image for fleet-world: a Debian toolchain for the model's commands,
# plus the dsh-ssh helper that serves each session's files and processes from
# inside its container. fleet-world builds it at startup, tagged by a digest of
# this directory, and refuses a helper that differs from the host's copy.
FROM node:26.9.0-trixie-slim

RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl git less procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

COPY helper/package.json helper/package-lock.json /opt/fleet-world/helper/
RUN cd /opt/fleet-world/helper \
 && npm ci --no-audit --no-fund --no-update-notifier \
 && npm cache clean --force
