#!/usr/bin/env bash
# Commit explicitly before running. Does not stage files or bypass CI.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="$(git branch --show-current)"
[ "$BRANCH" != main ] || { echo 'Create a feature branch first.'; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Commit or stash changes first.'; exit 1; }
git push -u origin "$BRANCH"
PR="$(gh pr view --json number --jq .number 2>/dev/null || true)"
if [ -z "$PR" ]; then
  gh pr create --base main --fill
  PR="$(gh pr view --json number --jq .number)"
fi
CHECKS_READY=false
for attempt in $(seq 1 30); do
  COUNT="$(gh pr view "$PR" --json statusCheckRollup --jq '.statusCheckRollup | length')"
  if [ "$COUNT" -gt 0 ]; then CHECKS_READY=true; break; fi
  sleep 2
done
[ "$CHECKS_READY" = true ] || { echo 'Checks have not started; PR remains open for review.'; exit 1; }
gh pr checks "$PR" --watch --fail-fast
gh pr merge "$PR" --squash --delete-branch
