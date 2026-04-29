#!/usr/bin/env bash
# Cross-file unused-export gate, powered by ts-prune.
#
# Why a wrapper? `ts-prune` always exits 0 — it just prints findings. We need
# a non-zero exit on any reported export so it can plug into `pnpm lint` /
# the CI quality job.
#
# Lines marked with `(used in module)` represent symbols only consumed inside
# their declaring file (i.e., they could have been local). We don't fail those
# in M1 — `noUnusedLocals` + `unused-imports/no-unused-vars` already cover the
# in-file case from a different angle. We fail only on truly unused exports.

set -euo pipefail

cd "$(dirname "$0")/.."

# `ts-prune` honours tsconfig include/exclude. Run it from the repo root.
output=$(pnpm exec ts-prune --error 2>/dev/null || true)

# Filter: drop "(used in module)" rows — those are advisory, not breaking.
# Drop blank lines.
filtered=$(echo "$output" | grep -v '(used in module)' | grep -E '\S' || true)

if [ -n "$filtered" ]; then
  echo "ERROR: unused exports detected (cross-file). Either remove them or" >&2
  echo "       mark the symbol as internal/private:" >&2
  echo "$filtered" >&2
  exit 1
fi
