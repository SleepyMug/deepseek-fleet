# Session image for fleet-world: a Debian toolchain for the model's commands,
# plus the dsh-ssh helper that serves each session's files and processes from
# inside its container. Build it with the fleet-image app (`dsh fleet-image`)
# before starting dsh; it is tagged by a digest of IMAGE_INPUTS (src/image.ts),
# which are also its whole build context, and must carry the host's dsh-ssh
# helper.
FROM node:26.9.0-trixie-slim

RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl git less procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

COPY helper/package.json helper/npm-shrinkwrap.json /opt/fleet-world/helper/
RUN cd /opt/fleet-world/helper \
 && npm ci --no-audit --no-fund --no-update-notifier \
 && npm cache clean --force
