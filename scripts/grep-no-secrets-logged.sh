#!/usr/bin/env bash
# Security gate: known secret-bearing names must not appear on lines with logging primitives.
# Replaces / extends grep-no-token-logged.sh.

set -euo pipefail

if [ ! -d src ]; then
  exit 0
fi

# Patterns we treat as secret-bearing
secrets='(MURMUR_TOKEN|CLOUDFLARE_TUNNEL_TOKEN|CLOUDFLARE_API_TOKEN|HETZNER_GH_TOKEN|GHCR_PAT|HETZNER_SSH_KEY|GRAFANA_(PROM|LOKI)_(USERNAME|PASSWORD)|OPENAI_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL|webhook_secret|_TOKEN|_PASSWORD|_SECRET|_API_KEY)'

# Logging / serialization primitives
loggers='(console\.|logger\.|log\.|out\.|stderr|stdout|JSON\.stringify\(.*\b(env|process|secrets)\b)'

hits=$(grep -nE "$secrets" src/ -r --include='*.ts' --include='*.tsx' 2>/dev/null \
       | grep -E "$loggers" \
       || true)

if [ -n "$hits" ]; then
  echo "ERROR: secret-bearing identifier appears on a line with a logging primitive — secrets must never be logged:" >&2
  echo "$hits" >&2
  exit 1
fi
