#!/usr/bin/env bash
# Security gate: MURMUR_TOKEN must never appear in console.log / logger / out lines.

set -euo pipefail

if [ ! -d src ]; then
  exit 0
fi

# Find any line that mentions MURMUR_TOKEN AND a logging primitive on the same line.
hits=$(grep -nE 'MURMUR_TOKEN' src/ -r --include='*.ts' --include='*.tsx' 2>/dev/null \
       | grep -E '(console\.|logger\.|out\.|log\.)' \
       || true)

if [ -n "$hits" ]; then
  echo "ERROR: MURMUR_TOKEN appears on a line with a logging primitive — token must never be logged:" >&2
  echo "$hits" >&2
  exit 1
fi
