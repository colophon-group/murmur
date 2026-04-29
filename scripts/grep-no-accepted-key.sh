#!/usr/bin/env bash
# M0 envelope gate: no `accepted:` JSON-key shape outside legacy paths.
# All response envelopes use `{ ok, errors?, data? }` (docs/contracts.md §4.4).
#
# Matches the literal `accepted:\s` form in TS/JS source — covers both
# the quoted JSON form (`"accepted":`) and the unquoted TS object-literal
# form (`{ accepted: true }`). The M0 issue's verification text names
# `\baccepted:\s`; this script implements that pattern with `[[:space:]]*`
# allowing zero-or-more whitespace between the key and the colon.
#
# Search roots (must match docs/contracts.md §4.4):
#   - top-level `src/` and `test/` (single-package layout, if it exists)
#   - `packages/*/src/` and `packages/*/test/`
#   - `apps/*/src/` and `apps/*/test/`
#
# Exclusions:
#   - any path containing `_legacy` (DESIGN.md §3.4 historical text)
#   - any line containing the inline marker `grep-no-accepted-key:allow`
#     (used by the type-system regression tests that PROVE the legacy
#      shape is rejected — those references are load-bearing assertions)

set -euo pipefail

cd "$(dirname "$0")/.."

# Build the list of search roots that actually exist.
roots=()
for d in src test packages/*/src packages/*/test apps/*/src apps/*/test; do
  if [ -d "$d" ]; then
    roots+=("$d")
  fi
done

if [ ${#roots[@]} -eq 0 ]; then
  # Nothing to scan — silently succeed. (Pre-package-bootstrap state.)
  exit 0
fi

# Find candidate TS/JS files, excluding _legacy and node_modules.
files=$(find "${roots[@]}" \
  \( -path '*/_legacy/*' -o -path '*/node_modules/*' \) -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' \) -print \
  2>/dev/null || true)

if [ -z "$files" ]; then
  exit 0
fi

# `(^|[^A-Za-z0-9_"])"?accepted"?[[:space:]]*:` — matches both forms:
#   - bare TS object literal:   `{ accepted: true }`
#   - quoted JSON form:         `{ "accepted": true }`
# The leading non-word/non-quote alternation acts as a portable word
# boundary (POSIX ERE has no `\b`), preventing false positives like
# `unaccepted:` or `xaccepted:`. Use grep -E for portable ERE (works on
# BSD grep on macOS and GNU grep on Linux).
#
# After matching, drop lines bearing the inline allowlist marker so the
# load-bearing type-rejection tests (and prose comments referencing the
# banned shape) can mention `accepted:` explicitly without tripping the
# gate.
hits=$(echo "$files" \
  | xargs grep -nE '(^|[^A-Za-z0-9_"])"?accepted"?[[:space:]]*:' 2>/dev/null \
  | grep -v 'grep-no-accepted-key:allow' \
  || true)

if [ -n "$hits" ]; then
  echo "ERROR: 'accepted:' key found. Use M0's { ok, errors?, data? } envelope (docs/contracts.md §4):" >&2
  echo "$hits" >&2
  exit 1
fi
