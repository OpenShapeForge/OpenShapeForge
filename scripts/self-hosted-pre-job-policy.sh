#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
#
# SECURITY BOUNDARY: runner operators must install this policy as an immutable,
# root-owned file outside the Actions workspace and point
# ACTIONS_RUNNER_HOOK_JOB_STARTED at that installed copy. Never execute the hook
# from a pull-request checkout: PR code can replace every file in its workspace.
# The repository copy is the reviewed source and test fixture for the installed
# hook, not a safe runtime location.

set -euo pipefail

readonly EXPECTED_REPOSITORY="OpenShapeForge/OpenShapeForge"
readonly APPROVED_WORKFLOW_SHAS_FILE="/opt/openshapeforge-runner/approved-workflow-shas"
readonly -a APPROVED_ROUTES=(
  ".github/workflows/ci.yml#db-tests"
  ".github/workflows/ci.yml#gates"
  ".github/workflows/ci.yml#helm"
  ".github/workflows/ci.yml#keycloak-spi"
  ".github/workflows/ci.yml#scan"
  ".github/workflows/docker-api.yml#build"
  ".github/workflows/docker-keycloak.yml#build"
  ".github/workflows/web-e2e.yml#browser-e2e"
)

deny() {
  echo "Self-hosted runner policy denied this job before workflow steps ran." >&2
  exit 1
}

main() {
local workflow_ref workflow_path workflow_revision route approved_route approved_sha
local route_approved workflow_sha_approved

if [[ "$#" -eq 1 && "$1" == "--print-approved-routes" ]]; then
  printf '%s\n' "${APPROVED_ROUTES[@]}"
  return 0
fi
[[ "$#" -eq 0 ]] || deny

[[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]] || deny
[[ "${GITHUB_REPOSITORY:-}" == "$EXPECTED_REPOSITORY" ]] || deny
[[ -n "${GITHUB_EVENT_PATH:-}" && -r "$GITHUB_EVENT_PATH" ]] || deny
[[ -n "${GITHUB_WORKFLOW_REF:-}" && -n "${GITHUB_WORKFLOW_SHA:-}" ]] || deny
[[ -n "${GITHUB_JOB:-}" ]] || deny
[[ "$GITHUB_WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]] || deny
[[ -f "$APPROVED_WORKFLOW_SHAS_FILE" && ! -L "$APPROVED_WORKFLOW_SHAS_FILE" ]] || deny

# GitHub documents the github context as caller-associated for reusable
# workflows. Bind its fixed repository/path to a host-authorized workflow SHA;
# GITHUB_JOB alone may identify a job in the reusable callee. The host snapshots
# every active same-repository PR run and verifies every routed workflow file at
# each possible SHA immediately before it installs this allow-list and admits
# routing.
workflow_ref="${GITHUB_WORKFLOW_REF#"$EXPECTED_REPOSITORY/"}"
[[ "$workflow_ref" != "$GITHUB_WORKFLOW_REF" && "$workflow_ref" == *@* ]] || deny
workflow_path="${workflow_ref%@*}"
workflow_revision="${workflow_ref##*@}"
[[ -n "$workflow_path" && -n "$workflow_revision" ]] || deny

route="$workflow_path#$GITHUB_JOB"
route_approved=false
for approved_route in "${APPROVED_ROUTES[@]}"; do
  if [[ "$route" == "$approved_route" ]]; then
    route_approved=true
    break
  fi
done
[[ "$route_approved" == true ]] || deny

workflow_sha_approved=false
while IFS= read -r approved_sha || [[ -n "$approved_sha" ]]; do
  [[ "$approved_sha" =~ ^[0-9a-f]{40}$ ]] || deny
  if [[ "$GITHUB_WORKFLOW_SHA" == "$approved_sha" ]]; then
    workflow_sha_approved=true
  fi
done <"$APPROVED_WORKFLOW_SHAS_FILE"
[[ "$workflow_sha_approved" == true ]] || deny

/usr/bin/env -i /usr/bin/jq -e --arg repository "$EXPECTED_REPOSITORY" '
  .repository.full_name == $repository and
  .pull_request.base.repo.full_name == $repository and
  .pull_request.head.repo.full_name == $repository and
  .pull_request.head.repo.fork == false
' "$GITHUB_EVENT_PATH" >/dev/null || deny

echo "Self-hosted runner policy accepted an approved same-repository pull request route."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
