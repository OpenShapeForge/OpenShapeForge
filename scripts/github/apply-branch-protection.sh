#!/usr/bin/env sh
# Applies the branch-protection ruleset to OpenShapeForge/OpenShapeForge.
# Requires the repo to be PUBLIC (or GitHub Pro) — rulesets are not available
# on private repos on the free plan. Run once the repo is public, and again
# after any edit to protect-main.ruleset.json:
#
#   sh scripts/github/apply-branch-protection.sh
#
# Protects the default branch: all changes via PR, >=1 approving review from a
# CODEOWNER, stale reviews dismissed on push, conversations resolved, linear
# history, no force-push, no deletion, and every CI gate green.
#
# Repository admins can bypass IN PULL REQUESTS ONLY (bypass_mode
# "pull_request"), not with a direct push to the default branch. "always" — the
# previous setting — let an admin, or anyone who compromised an admin account,
# push straight to main with no review and no CI (issue #47). The pull_request
# bypass keeps the emergency valve that stops a single-CODEOWNER repo from
# deadlocking on its own review requirement, while still forcing the change
# through a PR that CI has run against and that leaves a reviewable trail.
#
# Required checks are matched BY JOB NAME, so renaming a job in
# .github/workflows/** silently stops enforcing it until this file is updated
# and re-applied. strict_required_status_checks_policy is false: checks must
# pass on the PR head, but a PR need not be rebased onto every intervening
# commit on main. Set it to true to require that too.
set -e
REPO="${REPO:-OpenShapeForge/OpenShapeForge}"
DIR="$(dirname "$0")"
FILE="$DIR/protect-main.ruleset.json"

# Update in place when the ruleset already exists: a plain POST fails with a
# duplicate-name error, which is exactly what a re-run after editing the rules
# would hit.
ID="$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "protect-main") | .id' 2>/dev/null || true)"

if [ -n "$ID" ]; then
  gh api -X PUT "repos/$REPO/rulesets/$ID" --input "$FILE" >/dev/null
  echo "Updated protect-main ruleset ($ID) on $REPO."
else
  gh api -X POST "repos/$REPO/rulesets" --input "$FILE" >/dev/null
  echo "Applied protect-main ruleset to $REPO."
fi
