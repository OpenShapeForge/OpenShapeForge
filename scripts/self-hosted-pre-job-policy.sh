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

deny() {
  echo "Self-hosted runner policy denied this job before workflow steps ran." >&2
  exit 1
}

[[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]] || deny
[[ "${GITHUB_REPOSITORY:-}" == "$EXPECTED_REPOSITORY" ]] || deny
[[ -n "${GITHUB_EVENT_PATH:-}" && -r "$GITHUB_EVENT_PATH" ]] || deny

jq -e --arg repository "$EXPECTED_REPOSITORY" '
  .repository.full_name == $repository and
  .pull_request.base.repo.full_name == $repository and
  .pull_request.head.repo.full_name == $repository and
  .pull_request.head.repo.fork == false
' "$GITHUB_EVENT_PATH" >/dev/null || deny

echo "Self-hosted runner policy accepted a same-repository pull request."
