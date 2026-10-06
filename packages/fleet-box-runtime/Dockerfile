# The box image: Node, with this package on top at /opt/fleet as it would be
# packed (src/layout.ts). `buildImage()` (src/image/build.ts) stages the
# package in the build context's fleet/, compiled, with the packages it
# depends on as installed on the host in fleet/node_modules
# (src/image/stage.ts), so nothing is installed or compiled here.
ARG NODE_IMAGE=node:26.9.0-trixie
FROM ${NODE_IMAGE}
# The package and its node_modules at once; the links between packages in
# node_modules are relative, and stay links.
COPY fleet/ /opt/fleet/
# The host runs `sleep infinity` in every box, and the helper with `docker exec`.
ENTRYPOINT []
