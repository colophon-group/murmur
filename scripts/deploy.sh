#!/usr/bin/env bash
# scripts/deploy.sh — Hetzner deploy entrypoint, executed on the box by
# the GH Action `.github/workflows/deploy.yml` over SSH.
#
# Source spec: DESIGN.md §6.3 ("Deploy pipeline") and issue #19.
#
# Contract:
#   1. `set -euo pipefail` at the top so any failure aborts the deploy.
#   2. Validates required env vars; if any are missing, prints the names
#      (NEVER values) to stderr and exits non-zero.
#   3. Logs in to GHCR using `--password-stdin` (keeps the PAT off argv).
#   4. Writes /home/deploy/.env with mode 600 BEFORE writing values
#      (`umask 077`). The file holds runtime secrets consumed by
#      docker-compose.yml.
#   5. `docker compose pull && docker compose up -d --remove-orphans`.
#   6. Runs `pnpm migrate` inside the running murmur container via
#      `docker compose exec -T murmur pnpm migrate`. Exits non-zero if
#      migrations fail (set -e propagates).
#
# Idempotence: re-running on the same image digest is a no-op:
#   - docker compose pull returns cached layers,
#   - up -d only restarts services whose config or image changed,
#   - pnpm migrate is no-op if no pending migrations.
#
# Recovery: `docker compose down && docker compose up -d` pulls the
# previous tag from local cache (no rollback registry needed for MVP).
#
# Required env vars (set by the SSH action's `envs:` from the
# `production` GH environment):
#   OWNER                    — GH org for the GHCR image (also used for
#                              docker login username)
#   GHCR_PAT                 — token with `read:packages` scope
#   MURMUR_TOKEN             — bearer for publishers (DESIGN §3.6)
#   CLOUDFLARE_TUNNEL_TOKEN  — base64 token from Cloudflare Zero Trust
#
# Optional env vars (compose has defaults):
#   DATABASE_PATH            — defaults to /mnt/murmur/murmur.db inside
#                              the container; the host mount lives on
#                              the dedicated volume.

set -euo pipefail

# NOTE: The exit-code 7 sentinel is only used by the test harness to
# distinguish "stub not implemented" from a real env-var failure (1).
# It is removed in the implementation step.
echo "deploy.sh: not implemented" >&2
exit 7
