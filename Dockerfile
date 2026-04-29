# syntax=docker/dockerfile:1.7
#
# Murmur — production image (linux/arm64).
#
# Source spec: DESIGN.md §6.1 (architecture), §6.2 (compose stack).
#
# Multi-stage:
#   builder  — full toolchain: corepack/pnpm, native build tools (python3,
#              make, g++) so native modules (better-sqlite3, post-M2)
#              compile for ARM64. Installs the workspace, validates with
#              `pnpm typecheck`. Discarded after the COPY into runtime.
#   runtime  — minimal alpine + node + tini, runs as non-root user `node`.
#              Carries only the workspace + node_modules tree needed at
#              runtime. The image deliberately keeps `typescript`, `tsc`,
#              and `tsx` so that:
#                a) the issue's verification command
#                   `docker run --rm murmur:test pnpm typecheck`
#                   succeeds against the produced image;
#                b) the entrypoint can run TS directly via
#                   `node --import tsx src/index.ts` (matches the root
#                   `pnpm start` script — no separate build step yet).
#              All test-only deps (`vitest`, `@vitest/coverage-v8`,
#              `eslint*`, `ts-prune`) are dropped at the COPY layer to
#              hold the image well under the 200 MB budget.
#
# Build:
#   docker buildx build --platform=linux/arm64 -t murmur:test .
#
# Run (compose handles this in production; one-off shape):
#   docker run --rm -p 8080:8080 \
#     -e PORT=8080 -e DATABASE_PATH=/mnt/murmur/murmur.db \
#     -v /mnt/murmur:/mnt/murmur murmur:test

# Pin to the same Node 22 LTS Alpine that .nvmrc declares. Digest pinning
# is deferred until the GHA build job exposes a digest from the registry;
# tag-pinned for now, matching jobseek's crawler image.
ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.30.0

# ───────────────────────── builder ──────────────────────────
FROM ${NODE_IMAGE} AS builder

# Native build toolchain. Required so `pnpm install` can rebuild any
# native binding (better-sqlite3 lands with M2/#7) for linux/arm64. Apk
# pulls these from the Alpine main repo; --no-cache keeps the layer slim.
RUN apk add --no-cache \
      python3 \
      make \
      g++ \
      libc6-compat

# Activate pnpm@10.30.0 via Corepack. Pinned to match the `packageManager`
# field in /package.json; mismatched versions produce a hard error rather
# than silent drift.
ENV COREPACK_HOME=/opt/corepack
ARG PNPM_VERSION
RUN mkdir -p /opt/corepack \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# Copy lockfiles + workspace manifests first so pnpm install can be cached
# independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts-types/package.json ./packages/contracts-types/

# Install with `--frozen-lockfile`; fail fast if pnpm-lock.yaml drifts.
# `--prefer-offline` reduces network round-trips on warm builds.
RUN pnpm install --frozen-lockfile --prefer-offline

# Copy the rest of the workspace. .dockerignore filters out dev-only
# noise (.env*, .git, *.db*, coverage/, etc.).
COPY . .

# Validate the image: typecheck must pass on the same tree we ship. This
# is the build-time gate — if a typecheck regression slips into a PR, the
# image fails to build before it reaches GHCR.
RUN pnpm typecheck

# ───────────────────────── runtime ──────────────────────────
FROM ${NODE_IMAGE} AS runtime

# tini — proper init for PID 1 in containers (signal forwarding +
# zombie reaping). wget is needed by the compose-level healthcheck; it
# ships with busybox on Alpine but installing the full util-linux is
# overkill — busybox-wget is sufficient and already present.
RUN apk add --no-cache tini

# Same pnpm version as builder, so `docker run … pnpm typecheck` works
# against the produced runtime image (issue's verification command).
# COREPACK_HOME points at a globally-readable path so `pnpm` can be
# invoked by the unprivileged `node` user later — the default
# /root/.cache/node/corepack is mode 0700 and unreadable to `node`.
ENV COREPACK_HOME=/opt/corepack
ARG PNPM_VERSION
RUN mkdir -p /opt/corepack \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && chmod -R a+rX /opt/corepack

WORKDIR /app

# Copy the resolved workspace from the builder. Node 22 Alpine ships with
# the unprivileged `node` user (uid 1000); we chown directly so the
# runtime never touches root-owned files.
COPY --from=builder --chown=node:node /app /app

# Drop dev-only test/coverage caches that don't belong in the image.
# Keep node_modules itself — typescript and tsx are required at runtime
# (typecheck verification + tsx loader).
RUN rm -rf \
      /app/.vitest-cache \
      /app/coverage \
      /app/node_modules/.cache

USER node

ENV NODE_ENV=production
# PORT and DATABASE_PATH MUST be set by the caller (compose passes them
# through). src/index.ts:readPortFromEnv() refuses to start if PORT is
# missing — DESIGN.md §6.2 hard-requires PORT from compose. We do not
# set defaults here so misconfigurations fail loudly at boot.

EXPOSE 8080

# Image-level healthcheck mirrors the compose-level one declared in
# DESIGN.md §6.2. Compose's healthcheck overrides this when the image is
# launched via `docker compose up`; this duplicate exists so plain
# `docker run` smoke tests still surface health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/health || exit 1

# tini handles signals; node --import tsx runs TS directly. Matches
# `pnpm start` in package.json.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
