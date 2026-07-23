#!/usr/bin/env sh
# Applies the branch-protection ruleset to OpenShapeForge/OpenShapeForge.
# Requires the repo to be PUBLIC (or GitHub Pro) — rulesets are not available
# on private repos on the free plan. Run once the repo is public:
#
#   sh scripts/github/apply-branch-protection.sh
#
# Protects the default branch: all changes via PR, >=1 approving review from a
# CODEOWNER, stale reviews dismissed on push, conversations resolved, linear
# history, no force-push, no deletion, and the CI status checks (gates,
# keycloak-spi, helm, db-tests) must pass. Repository admins are limited to the
# pull_request bypass context — they still open a PR and cannot push unreviewed
# commits directly to the default branch.
set -e
REPO="${REPO:-OpenShapeForge/OpenShapeForge}"
DIR="$(dirname "$0")"
gh api -X POST "repos/$REPO/rulesets" --input "$DIR/protect-main.ruleset.json"
echo "Applied protect-main ruleset to $REPO."
