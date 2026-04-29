#!/usr/bin/env bash
# Cross-file unused-export gate, powered by ts-prune.
#
# Why a wrapper? `ts-prune` always exits 0 — it just prints findings. We need
# a non-zero exit on any reported export so it can plug into `pnpm lint` /
# the CI quality job.
#
# Filtering rules:
#   - Drop `(used in module)` rows. Those are advisory: the symbol is only
#     consumed inside its declaring file. `noUnusedLocals` already covers the
#     in-file case from a different angle, so we don't fail those in M1.
#   - Drop config-file default exports (`*.config.ts`, `eslint.config.js`).
#     Those are picked up by tooling by *file path*, not by import — ts-prune
#     can't see the consumer, so it always reports them as unused.

set -euo pipefail

cd "$(dirname "$0")/.."

# `ts-prune` honours tsconfig include/exclude. Run it from the repo root.
output=$(pnpm exec ts-prune --error 2>/dev/null || true)

# Filter pipeline:
#   1. Drop "used in module" advisory rows.
#   2. Drop config-file findings (vitest.config.ts, eslint.config.js, etc.)
#      whose default export is consumed by tooling at a file path.
#   3. Drop blank lines.
filtered=$(echo "$output" \
  | grep -v '(used in module)' \
  | grep -vE '^[A-Za-z0-9_./-]+\.config\.(ts|js|cjs|mjs):[0-9]+ - default$' \
  | grep -vE '^eslint\.config\.(js|mjs|cjs):[0-9]+ - default$' \
  | grep -E '\S' || true)

if [ -n "$filtered" ]; then
  echo "ERROR: unused exports detected (cross-file). Either remove them or" >&2
  echo "       mark the symbol as internal/private:" >&2
  echo "$filtered" >&2
  exit 1
fi
