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
#
# Test override:
#   DEPLOY_DIR — defaults to /home/deploy. Set to a tmp dir by the
#                vitest harness so unit tests don't touch the real path.

set -euo pipefail

# ── Paths ────────────────────────────────────────────────────────────
# DEPLOY_DIR is the directory holding docker-compose.yml + .env on the
# box. Tests override this to an isolated tmpdir. The default matches
# the SCP target in `.github/workflows/deploy.yml`.
DEPLOY_DIR="${DEPLOY_DIR:-/home/deploy}"

# ── Validate required env vars ───────────────────────────────────────
# We check for *unset or empty*. The error message lists the missing
# names but NEVER prints values.
required_vars=(
  OWNER
  GHCR_PAT
  MURMUR_TOKEN
  CLOUDFLARE_TUNNEL_TOKEN
)

missing=()
for var in "${required_vars[@]}"; do
  # `${!var:-}` is bash indirect expansion; the `:-` default keeps
  # `set -u` quiet when the var is unset.
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: Missing required env vars: ${missing[*]}" >&2
  exit 1
fi

# ── Login to GHCR (stdin, never argv) ────────────────────────────────
# `--password-stdin` keeps the PAT out of `ps` output and shell history.
# The here-string `<<<` feeds GHCR_PAT into stdin without a temp file.
docker login ghcr.io --username "$OWNER" --password-stdin <<<"$GHCR_PAT"

# ── Write env file (mode 600) ────────────────────────────────────────
# umask 077 BEFORE the redirect so the file is created with mode 0600
# from the start (no race window where it briefly exists at 0644).
# We restore umask afterwards in case the shell continues with other
# operations that need group/other read.
mkdir -p "$DEPLOY_DIR"
prev_umask=$(umask)
umask 077
cat > "$DEPLOY_DIR/.env" <<EOF
OWNER=${OWNER}
MURMUR_TOKEN=${MURMUR_TOKEN}
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
DATABASE_PATH=${DATABASE_PATH:-/mnt/murmur/murmur.db}
EOF
umask "$prev_umask"

# Defence-in-depth: chmod regardless. Cheaper than relying on umask
# alone if a future edit reorders the writes.
chmod 600 "$DEPLOY_DIR/.env"

# ── Pull images and restart the stack ────────────────────────────────
cd "$DEPLOY_DIR"
docker compose pull
docker compose up -d --remove-orphans

# ── Run migrations against the live container ────────────────────────
# `docker compose exec -T` disables TTY allocation (required from a
# non-interactive SSH session). If migrations fail, `set -e` aborts
# the deploy with a non-zero exit code.
docker compose exec -T murmur pnpm migrate

echo "Deploy complete."
