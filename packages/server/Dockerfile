# Build context is the repo root (multiplayer-markdown/), not this directory —
# the server package depends on @multiplayer-markdown/sync-core via the pnpm
# workspace, so the whole monorepo needs to be visible to the build.
#
#   docker build -f packages/server/Dockerfile -t multiplayer-markdown-server .
#
# Native modules (better-sqlite3, argon2) are compiled inside this image
# during `pnpm install`, so they're built for the container's platform —
# never copy node_modules built on the host into a runtime image instead.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/sync-core/package.json packages/sync-core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/plugin/package.json packages/plugin/package.json
RUN pnpm install --frozen-lockfile

COPY packages/sync-core packages/sync-core
COPY packages/server packages/server
RUN pnpm --filter @multiplayer-markdown/sync-core run build
RUN pnpm --filter @multiplayer-markdown/server run build

# `pnpm deploy` produces a self-contained directory for just this package:
# workspace deps (sync-core) resolved as real files, prod-only node_modules,
# no symlinks — exactly what a runtime image needs. This is pnpm's own
# documented pattern for monorepo Docker builds, not a custom workaround.
# --legacy is required on pnpm v10+: plain `pnpm deploy` refuses to run
# unless "inject-workspace-packages=true" is set (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE)
# — confirmed by actually running this command locally, not just reading docs.
RUN pnpm --filter @multiplayer-markdown/server --prod deploy /prod/server --legacy

FROM base AS server
COPY --from=build /prod/server /prod/server
WORKDIR /prod/server
EXPOSE 4444 4445
CMD ["node", "dist/index.js"]
