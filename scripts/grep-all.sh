#!/usr/bin/env bash
# Run all grep gates. Exits non-zero if any gate fails.

set -euo pipefail

cd "$(dirname "$0")/.."

failed=0
for gate in \
  scripts/grep-no-naked-eq-in-auth.sh \
  scripts/grep-uses-timingsafeequal.sh \
  scripts/grep-no-accepted-key.sh \
  scripts/grep-no-secrets-logged.sh
do
  if [ -x "$gate" ]; then
    echo "→ $gate"
    if ! bash "$gate"; then
      failed=1
    fi
  fi
done

if [ $failed -ne 0 ]; then
  echo
  echo "ERROR: one or more grep gates failed." >&2
  exit 1
fi

echo "All grep gates passed."
