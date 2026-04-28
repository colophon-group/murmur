#!/usr/bin/env bash
# M3 quality gate: src/auth/** must NOT contain naked equality on tokens.
# Use crypto.timingSafeEqual instead.

set -euo pipefail

if [ ! -d src/auth ]; then
  # Auth module not yet implemented (pre-M3) — pass.
  exit 0
fi

if grep -nrE '\b(===|!==|Buffer\.compare|String\.prototype\.localeCompare)\b' src/auth/ \
    --include='*.ts' --include='*.tsx' \
    --exclude-dir=__tests__ --exclude='*.test.ts' --exclude='*.spec.ts'; then
  echo "ERROR: src/auth/** contains naked equality. Use crypto.timingSafeEqual for token comparisons." >&2
  exit 1
fi
