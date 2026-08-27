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

command -v jq >/dev/null 2>&1 || {
  echo "Self-hosted runner policy requires jq, but jq is not installed." >&2
  deny
}

# Workflow-level `env:` can shadow the default variables passed to a job-started
# hook. Do not trust the event path merely because it came through a GITHUB_*
# name: require the runner-created payload location and ownership as well. A PR
# has not executed when this hook runs, so it cannot create or alter this file
# on the required ephemeral runner.
event_path="$(realpath "$GITHUB_EVENT_PATH" 2>/dev/null)" || deny
[[ "$event_path" == */_work/_temp/_github_workflow/event.json ]] || deny

if [[ "$(uname -s)" == "Darwin" ]]; then
  event_uid="$(stat -f '%u' "$event_path")" || deny
  event_mode="$(stat -f '%Lp' "$event_path")" || deny
else
  event_uid="$(stat -c '%u' "$event_path")" || deny
  event_mode="$(stat -c '%a' "$event_path")" || deny
fi
[[ "$event_uid" == "$(id -u)" ]] || deny
(( (8#$event_mode & 8#022) == 0 )) || deny

jq -e --arg repository "$EXPECTED_REPOSITORY" '
  .repository.full_name == $repository and
  .pull_request.base.repo.full_name == $repository and
  .pull_request.head.repo.full_name == $repository and
  .pull_request.head.repo.fork == false
' "$GITHUB_EVENT_PATH" >/dev/null || deny

echo "Self-hosted runner policy accepted a same-repository pull request."
