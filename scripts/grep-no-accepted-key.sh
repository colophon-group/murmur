#!/usr/bin/env bash
# M0 envelope gate: no `{ accepted: ... }` shape outside legacy paths.
# All response envelopes use { ok, errors?, data? }.

set -euo pipefail

if [ ! -d src ] && [ ! -d test ]; then
  exit 0
fi

# Look in src and test, exclude legacy
hits=$(grep -nE '"\baccepted\b"\s*:' \
       $(find src test 2>/dev/null | grep -v '_legacy' | grep -E '\.(ts|tsx|js)$' || true) \
       2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "ERROR: '{ accepted: ... }' shape found. Use M0's { ok, errors?, data? } envelope:" >&2
  echo "$hits" >&2
  exit 1
fi
