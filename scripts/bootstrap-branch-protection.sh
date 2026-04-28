#!/usr/bin/env bash
# One-time configuration of branch protection on main.
# Idempotent: re-running just confirms the current state.

set -euo pipefail

REPO="${1:-colophon-group/murmur}"

echo "Configuring branch protection on $REPO main…"

# Use the modern checks[] form (contexts is deprecated). enforce_admins=true
# means even repo admins (including the orchestrator's identity) must satisfy
# the gates. required_approving_review_count=0 because GitHub forbids self-
# review and we rely on the reviewer-agent's PR comments + CI for quality.
gh api -X PUT "repos/${REPO}/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "quality" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "required_conversation_resolution": true
}
JSON

echo "Branch protection applied. Verify with:"
echo "  gh api repos/${REPO}/branches/main/protection | jq '.required_status_checks, .enforce_admins'"
