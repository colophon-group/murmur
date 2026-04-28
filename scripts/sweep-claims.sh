#!/usr/bin/env bash
# Sweep expired claim comments and their orphan branches.
# Run by the orchestrator at the top of each loop iteration.
#
# A claim is the comment "Claimed by <handle> until <ISO timestamp>" on an open
# issue in either repo's milestone. If the timestamp has elapsed AND no PR was
# opened from `dev/<issue-num>-*`, the claim is considered abandoned: we delete
# the branch and remove the assignee.

set -euo pipefail

cd "$(dirname "$0")/.."

now_unix=$(date -u +%s)

sweep_repo() {
  local repo="$1"
  local milestone="$2"

  echo "→ sweeping $repo (milestone: $milestone)"

  # Get all open issues in the milestone with claim comments
  gh issue list --repo "$repo" --milestone "$milestone" --state open --json number --limit 100 --jq '.[].number' | while read -r issue_num; do
    [ -z "$issue_num" ] && continue

    # Find the most recent "Claimed by … until …" comment
    claim_line=$(gh issue view "$issue_num" --repo "$repo" --json comments --jq \
      '[.comments[] | select(.body | test("^Claimed by .* until "))] | last // empty')

    [ -z "$claim_line" ] && continue

    # Extract the ISO timestamp from the comment
    body=$(echo "$claim_line" | jq -r '.body')
    until_iso=$(echo "$body" | grep -oE 'until [^.]*' | sed 's/^until //;s/[. ]*$//')

    [ -z "$until_iso" ] && continue

    # Convert to unix epoch (best effort; macOS date and gnu date differ)
    until_unix=$(date -u -d "$until_iso" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$until_iso" +%s 2>/dev/null || echo 0)
    [ "$until_unix" = 0 ] && continue

    # Not yet expired? skip
    [ "$until_unix" -gt "$now_unix" ] && continue

    # Check whether a PR exists from dev/<issue_num>-*
    has_pr=$(gh pr list --repo "$repo" --search "head:dev/${issue_num}-" --state all --json number --jq 'length')
    if [ "$has_pr" -gt 0 ]; then
      # PR exists; not orphan. Don't sweep.
      continue
    fi

    # Orphan claim: delete any matching branches, clear assignee.
    echo "  issue #$issue_num: claim expired at $until_iso, no PR, sweeping"

    # Find branches matching dev/<issue_num>-*
    git -C "$(echo "$repo" | sed 's|colophon-group/||' | xargs -I{} echo "/Users/Viktor/{}")" \
      ls-remote origin "dev/${issue_num}-*" 2>/dev/null \
      | awk '{print $2}' | sed 's|^refs/heads/||' \
      | while read -r branch; do
        echo "    deleting origin/$branch"
        git -C "$(echo "$repo" | sed 's|colophon-group/||' | xargs -I{} echo "/Users/Viktor/{}")" \
          push origin --delete "$branch" 2>&1 || true
      done

    # Clear assignees on the issue (best effort)
    gh issue edit "$issue_num" --repo "$repo" --remove-assignee "@me" 2>&1 || true
  done
}

sweep_repo "colophon-group/murmur" "Demo readiness"
sweep_repo "colophon-group/jobseek" "Murmur demo readiness"

echo "Sweep complete."
