#!/usr/bin/env bash
# M3 quality gate: src/auth/** MUST import and use crypto.timingSafeEqual.

set -euo pipefail

if [ ! -d src/auth ]; then
  exit 0
fi

if ! grep -lF 'timingSafeEqual' src/auth/ -r --include='*.ts' >/dev/null 2>&1; then
  echo "ERROR: src/auth/** does not use crypto.timingSafeEqual. Constant-time token comparison required." >&2
  exit 1
fi
