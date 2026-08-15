#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1

# Versioned source for the macOS one-slot runner supervisor. `start` installs a
# private host copy so pull-request checkouts never control the running process.

set -euo pipefail

readonly REPOSITORY="OpenShapeForge/OpenShapeForge"
readonly SLOTS=(1)
readonly BROKEN_RECOVERY_PROFILE="osf-pr-1"
readonly COMMAND="${1:-status}"
readonly RUNNER_VERSION="2.336.0"
readonly RUNNER_SHA256="58b758e420b87093fbd4bfddd368074960053e2f1388f01848c82624b90f27d1"
readonly PLAYWRIGHT_VERSION="1.62.1"
readonly NODE_VERSION="22.23.2"
readonly NODE_SHA256="fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8"
readonly MAVEN_VERSION="3.9.16"
readonly MAVEN_SHA512="831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6"
readonly SUPPORT_DIR="${HOME}/Library/Application Support/OpenShapeForge Actions"
readonly LOG_DIR="${HOME}/Library/Logs/OpenShapeForgeActions"
readonly INSTALLED_SCRIPT="${SUPPORT_DIR}/local-actions-runners.sh"
readonly RUNNER_ARCHIVE="${SUPPORT_DIR}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz"
readonly PROVISION_LOCK="${SUPPORT_DIR}/provision.lock"
readonly HOST_LAUNCHER="/usr/local/libexec/openshapeforge-actions-launcher"
readonly HOST_FIREWALL_PLIST="/Library/LaunchDaemons/com.openshapeforge.actions.firewall.plist"
readonly HOST_FIREWALL_RULES="/Library/Application Support/OpenShapeForge Actions/pf-anchor.conf"
readonly ISOLATION_GROUP="${OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP:-_osfci}"
readonly RUNNER_USER="$(id -un)"
readonly RUNNER_UID="$(id -u)"
readonly RUNNER_NAME_PREFIX="${OPENSHAPEFORGE_RUNNER_NAME_PREFIX:-openshapeforge-pr}"
readonly DISABLED_DEPLOY_RUNNER_PREFIX="${OPENSHAPEFORGE_DEPLOY_RUNNER_PREFIX:-openshapeforge-deploy}"
readonly LATE_LIMA_START_ATTEMPTS=80
readonly LATE_LIMA_START_INTERVAL_SECONDS=3
readonly LIMA_READINESS_PROBE_TIMEOUT_SECONDS=10
# LaunchAgent scheduling and ownership-proof publication share this independent,
# bounded setup window; command runtime starts only after the handshake.
readonly PROBE_STARTUP_TIMEOUT_SECONDS=15
readonly PROBE_STARTUP_TIMEOUT_STATUS=123
readonly PROBE_COMMAND_FAILURE_STATUS=1
readonly PROVISION_TERMINATION_GRACE_ATTEMPTS=240

late_lima_start_attempt_limit() {
  printf '%s\n' "$LATE_LIMA_START_ATTEMPTS"
}

probe_startup_timeout_seconds() {
  printf '%s\n' "$PROBE_STARTUP_TIMEOUT_SECONDS"
}

provision_termination_grace_attempt_limit() {
  printf '%s\n' "$PROVISION_TERMINATION_GRACE_ATTEMPTS"
}

approved_workflow_sha256() {
  case "$1" in
    ".github/workflows/ci.yml")
      printf '%s\n' "4d3c9d983a7c9c8854bff17a7494b381660368ba83e2ec60779236cb84092fb2"
      ;;
    ".github/workflows/docker-api.yml")
      printf '%s\n' "873ddbae45b0e3bd8823243a788b58ebca869a019b2128e141ec063c64c15aba"
      ;;
    ".github/workflows/docker-keycloak.yml")
      printf '%s\n' "456a88525a9500c705f070a9078d198421159e8d537002d39e00107da35bb2fd"
      ;;
    ".github/workflows/web-e2e.yml")
      printf '%s\n' "b0182d193f448b2751e3c39be6600de3b517625bf1ba6d64dc30ca07addeb47c"
      ;;
    *) return 1 ;;
  esac
}

print_approved_workflow_sha256() {
  local workflow_path
  while IFS= read -r workflow_path; do
    printf '%s %s\n' "$workflow_path" "$(approved_workflow_sha256 "$workflow_path")"
  done <<'EOF'
.github/workflows/ci.yml
.github/workflows/docker-api.yml
.github/workflows/docker-keycloak.yml
.github/workflows/web-e2e.yml
EOF
}

# A pull-request run's REST head_sha names the PR head, while
# GITHUB_WORKFLOW_SHA may name the fixed head, base, or synthesized merge
# revision that supplied the direct workflow. Resolve and authenticate all three
# possible revisions before registration instead of treating head_sha as the
# workflow revision.
active_same_repository_workflow_runs() {
  local pages active_runs
  if ! pages="$(
    gh api --hostname github.com --paginate --slurp \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "repos/${REPOSITORY}/actions/runs?event=pull_request&per_page=100"
  )"; then
    echo "Could not enumerate all pull-request workflow runs" >&2
    return 1
  fi
  if ! active_runs="$(
    printf '%s\n' "$pages" | jq -r \
      --arg repository "$REPOSITORY" '
      def sha: type == "string" and test("^[0-9a-f]{40}$");
      def direct_workflow_path:
        type == "string" and
        test("^\\.github/workflows/[A-Za-z0-9._-]+\\.ya?ml$");
      def active_status:
        . == "queued" or . == "in_progress" or . == "requested" or
        . == "waiting" or . == "pending";
      def known_status:
        active_status or . == "completed" or . == "action_required" or
        . == "cancelled" or . == "failure" or . == "neutral" or
        . == "skipped" or . == "stale" or . == "success" or
        . == "timed_out";
      if type != "array" or length == 0 or
        any(.[];
          type != "object" or
          (.workflow_runs | type) != "array" or
          (.total_count | type) != "number" or
          .total_count < 0 or .total_count != (.total_count | floor))
      then error("invalid workflow-run page")
      else
        . as $pages |
        ($pages[0].total_count) as $total_count |
        [$pages[].workflow_runs[]] as $runs |
        if any($pages[]; .total_count != $total_count) or
          ($runs | length) != $total_count or
          any($runs[];
            type != "object" or
            (.id | type) != "number" or .id <= 0 or
            .id != (.id | floor) or
            .event != "pull_request" or
            .repository.full_name != $repository or
            (.status | type) != "string" or (.status | known_status | not)) or
          ($runs | group_by(.id) | any(.[]; length != 1))
        then error("incomplete workflow-run pagination")
        else
          [$runs[] |
            select(.status | active_status) |
            if (.head_repository.full_name | type) != "string"
            then error("invalid head repository")
            elif .head_repository.full_name != $repository
            then empty
            elif
              (.run_attempt | type) != "number" or .run_attempt <= 0 or
              .run_attempt != (.run_attempt | floor) or
              (.path | direct_workflow_path | not) or
              (.head_sha | sha | not) or
              (.pull_requests | type) != "array" or
              (.pull_requests | length) != 1 or
              (.pull_requests[0].number | type) != "number" or
              .pull_requests[0].number <= 0 or
              .pull_requests[0].number != (.pull_requests[0].number | floor) or
              (.pull_requests[0].head.sha | sha | not) or
              (.pull_requests[0].base.sha | sha | not) or
              .head_sha != .pull_requests[0].head.sha
            then error("invalid direct pull-request run")
            else {
              id,
              run_attempt,
              path,
              head_sha,
              pull_request_number: .pull_requests[0].number,
              pull_request_head_sha: .pull_requests[0].head.sha,
              pull_request_base_sha: .pull_requests[0].base.sha
            }
            end
          ] |
          .[] |
          [
            .id,
            .run_attempt,
            .path,
            .head_sha,
            .pull_request_number,
            .pull_request_head_sha,
            .pull_request_base_sha
          ] | @tsv
        end
      end
    '
  )"; then
    echo "Pull-request workflow-run response was incomplete or malformed" >&2
    return 1
  fi
  if [[ -z "$active_runs" ]]; then
    echo "No active same-repository pull-request workflow run is available" >&2
    return 1
  fi
  printf '%s\n' "$active_runs"
}

validate_direct_workflow_run() {
  local run_id="$1"
  local run_attempt="$2"
  local workflow_path="$3"
  local run_head_sha="$4"
  local pull_request_number="$5"
  local pull_request_head_sha="$6"
  local pull_request_base_sha="$7"
  local run
  [[ "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$workflow_path" =~ ^\.github/workflows/[A-Za-z0-9._-]+\.ya?ml$ ]] || return 1
  [[ "$run_head_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$pull_request_number" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$pull_request_head_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$pull_request_base_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  if ! run="$(
    gh api --hostname github.com \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "repos/${REPOSITORY}/actions/runs/${run_id}/attempts/${run_attempt}"
  )"; then
    echo "Could not verify active workflow run ${run_id} attempt ${run_attempt}" >&2
    return 1
  fi
  if ! printf '%s\n' "$run" | jq -e \
    --arg repository "$REPOSITORY" \
    --arg workflow_path "$workflow_path" \
    --arg run_head_sha "$run_head_sha" \
    --arg pull_request_head_sha "$pull_request_head_sha" \
    --arg pull_request_base_sha "$pull_request_base_sha" \
    --argjson run_id "$run_id" \
    --argjson run_attempt "$run_attempt" \
    --argjson pull_request_number "$pull_request_number" '
      type == "object" and
      .id == $run_id and
      .run_attempt == $run_attempt and
      .event == "pull_request" and
      (
        .status == "queued" or .status == "in_progress" or
        .status == "requested" or .status == "waiting" or
        .status == "pending"
      ) and
      .path == $workflow_path and
      .head_sha == $run_head_sha and
      .repository.full_name == $repository and
      .head_repository.full_name == $repository and
      (.referenced_workflows | type) == "array" and
      (.referenced_workflows | length) == 0 and
      (.pull_requests | type) == "array" and
      (.pull_requests | length) == 1 and
      .pull_requests[0].number == $pull_request_number and
      .pull_requests[0].head.sha == $pull_request_head_sha and
      .pull_requests[0].base.sha == $pull_request_base_sha and
      .head_sha == .pull_requests[0].head.sha
    ' >/dev/null; then
    echo "Active workflow run ${run_id} metadata was malformed, stale, or reusable" >&2
    return 1
  fi
}

current_pull_request_workflow_shas() {
  local pull_request_number="$1"
  local expected_head_sha="$2"
  local expected_base_sha="$3"
  local pull_request candidate_shas
  [[ "$pull_request_number" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$expected_head_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$expected_base_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  if ! pull_request="$(
    gh api --hostname github.com \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "repos/${REPOSITORY}/pulls/${pull_request_number}"
  )"; then
    echo "Could not verify pull request ${pull_request_number}" >&2
    return 1
  fi
  if ! candidate_shas="$(
    printf '%s\n' "$pull_request" | jq -er \
      --arg repository "$REPOSITORY" \
      --arg expected_head_sha "$expected_head_sha" \
      --arg expected_base_sha "$expected_base_sha" \
      --argjson pull_request_number "$pull_request_number" '
      def sha: type == "string" and test("^[0-9a-f]{40}$");
      if
        type != "object" or
        .number != $pull_request_number or
        .state != "open" or
        .head.repo.full_name != $repository or
        .base.repo.full_name != $repository or
        .head.sha != $expected_head_sha or
        .base.sha != $expected_base_sha or
        (.merge_commit_sha | sha | not)
      then error("stale or malformed pull request")
      else [$expected_head_sha, $expected_base_sha, .merge_commit_sha] |
        unique | join("\n")
      end
    '
  )"; then
    echo "Pull request ${pull_request_number} no longer matches its workflow run" >&2
    return 1
  fi
  printf '%s\n' "$candidate_shas"
}

workflow_file_sha256_at() {
  local workflow_path="$1"
  local workflow_sha="$2"
  local digest_output digest
  [[ "$workflow_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  if ! digest_output="$(
    gh api --hostname github.com \
      -H "Accept: application/vnd.github.raw+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "repos/${REPOSITORY}/contents/${workflow_path}?ref=${workflow_sha}" |
      shasum -a 256
  )"; then
    echo "Could not fetch approved workflow ${workflow_path} at ${workflow_sha}" >&2
    return 1
  fi
  digest="${digest_output%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Could not hash approved workflow ${workflow_path} at ${workflow_sha}" >&2
    return 1
  }
  printf '%s\n' "$digest"
}

authorize_active_workflow_shas() {
  local active_runs run_id run_attempt workflow_path run_head_sha
  local pull_request_number pull_request_head_sha pull_request_base_sha run_candidate_shas
  local candidate_shas='' workflow_sha expected_sha256 actual_sha256
  local approved_workflow_shas='' workflow_revision_approved
  active_runs="$(active_same_repository_workflow_runs)" || return 1
  while IFS=$'\t' read -r run_id run_attempt workflow_path run_head_sha \
    pull_request_number pull_request_head_sha pull_request_base_sha; do
    validate_direct_workflow_run \
      "$run_id" "$run_attempt" "$workflow_path" "$run_head_sha" \
      "$pull_request_number" "$pull_request_head_sha" "$pull_request_base_sha" || return 1
    run_candidate_shas="$(
      current_pull_request_workflow_shas \
        "$pull_request_number" "$pull_request_head_sha" "$pull_request_base_sha"
    )" || return 1
    if [[ -n "$candidate_shas" ]]; then
      candidate_shas="${candidate_shas}"$'\n'"${run_candidate_shas}"
    else
      candidate_shas="$run_candidate_shas"
    fi
  done <<<"$active_runs"
  candidate_shas="$(
    printf '%s\n' "$candidate_shas" | jq -Rser \
      'split("\n") | map(select(length > 0)) | unique | join("\n")'
  )" || return 1
  [[ -n "$candidate_shas" ]] || return 1
  while IFS= read -r workflow_sha; do
    [[ "$workflow_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    workflow_revision_approved=true
    while IFS=' ' read -r workflow_path expected_sha256; do
      actual_sha256="$(workflow_file_sha256_at "$workflow_path" "$workflow_sha")" || return 1
      if [[ "$actual_sha256" != "$expected_sha256" ]]; then
        workflow_revision_approved=false
      fi
    done < <(print_approved_workflow_sha256)
    if [[ "$workflow_revision_approved" == true ]]; then
      if [[ -n "$approved_workflow_shas" ]]; then
        approved_workflow_shas="${approved_workflow_shas}"$'\n'"${workflow_sha}"
      else
        approved_workflow_shas="$workflow_sha"
      fi
    else
      echo "Workflow revision ${workflow_sha} differs from reviewed routed workflow content" >&2
    fi
  done <<<"$candidate_shas"
  if [[ -z "$approved_workflow_shas" ]]; then
    echo "No active workflow revision matches the reviewed routed workflow content" >&2
    return 1
  fi
  printf '%s\n' "$approved_workflow_shas"
}

validate_workflow_sha_allow_list() {
  local approved_workflow_shas="$1"
  local workflow_sha count=0
  [[ -n "$approved_workflow_shas" ]] || return 1
  while IFS= read -r workflow_sha; do
    [[ "$workflow_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    count=$((count + 1))
  done <<<"$approved_workflow_shas"
  ((count > 0))
}

require_host_tools() {
  local tool
  for tool in colima curl dscl find gh ifconfig ipconfig jq launchctl limactl lsof nc ps route shasum shlock stat unlink uuidgen; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "Required host tool is missing: $tool" >&2
      exit 1
    }
  done
}

require_runner_identity_values() {
  local variable_name value
  while IFS='=' read -r variable_name value; do
    if [[ -z "$value" || ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "${variable_name} must contain only letters, digits, dots, underscores or hyphens" >&2
      return 1
    fi
  done <<EOF
OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP=${ISOLATION_GROUP}
OPENSHAPEFORGE_RUNNER_NAME_PREFIX=${RUNNER_NAME_PREFIX}
OPENSHAPEFORGE_DEPLOY_RUNNER_PREFIX=${DISABLED_DEPLOY_RUNNER_PREFIX}
EOF
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

require_host_isolation() {
  local launcher_state firewall_state group_id
  group_id="$(dscl . -read "/Groups/${ISOLATION_GROUP}" PrimaryGroupID 2>/dev/null | awk '{ print $2 }')"
  [[ "$group_id" =~ ^[0-9]+$ ]] || {
    echo "Host isolation group is missing" >&2
    exit 1
  }
  launcher_state="$(stat -f '%u:%g:%Mp%Lp' "$HOST_LAUNCHER" 2>/dev/null || true)"
  [[ "$launcher_state" == "0:${group_id}:2755" ]] || {
    echo "Root-owned setgid runner launcher is not installed correctly" >&2
    exit 1
  }
  [[ "$($HOST_LAUNCHER --print-egid)" == "$group_id" ]] || {
    echo "Runner launcher did not assume the isolation group" >&2
    exit 1
  }
  firewall_state="$(stat -f '%u:%g:%OLp' "$HOST_FIREWALL_RULES" 2>/dev/null || true)"
  [[ "$firewall_state" == "0:0:644" ]] || {
    echo "Root-owned PF rules are not installed correctly" >&2
    exit 1
  }
  launchctl print system/com.openshapeforge.actions.firewall >/dev/null 2>&1 || {
    echo "Host firewall service is not loaded" >&2
    exit 1
  }
}

profile_for() {
  printf 'osf-pr-%s' "$1"
}

runner_prefix_for() {
  printf '%s-%s' "$RUNNER_NAME_PREFIX" "$1"
}

agent_label_for() {
  printf 'com.openshapeforge.actions.pr-%s' "$1"
}

plist_for() {
  printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(agent_label_for "$1")"
}

runner_service_for() {
  printf 'actions.runner.OpenShapeForge-OpenShapeForge.%s.service' "$1"
}

delete_repository_runner() {
  local id="$1"
  if ! gh api --method DELETE "repos/${REPOSITORY}/actions/runners/${id}" >/dev/null; then
    echo "Could not delete repository runner ${id}" >&2
    return 1
  fi
  return 0
}

delete_matching_runners() {
  local prefix="$1"
  local id ids
  if ! ids="$(
    gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
      --jq ".runners[] | select(.name | startswith(\"${prefix}\")) | .id"
  )"; then
    echo "Could not list repository runners for ${prefix}" >&2
    return 1
  fi
  while IFS= read -r id; do
    if [[ -n "$id" ]] && ! delete_repository_runner "$id"; then
      return 1
    fi
  done <<<"$ids"
  return 0
}

probe_parent_before_pid_lookup() {
  :
}

probe_process_active() {
  local pid="$1"
  local state
  probe_parent_before_pid_lookup "$pid"
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$state" && "$state" != Z* ]]
}

probe_process_owns_group() {
  local pid="$1"
  local pgid
  probe_process_active "$pid" || return 1
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ "$pgid" == "$pid" ]]
}

probe_process_group_is_sentinel_only() {
  local sentinel_pid="$1"
  local processes
  processes="$(ps -axo pid=,pgid=,stat= 2>/dev/null)" || return 1
  printf '%s\n' "$processes" | awk -v sentinel="$sentinel_pid" '
    NF == 0 { next }
    NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ {
      invalid = 1
      next
    }
    $2 == sentinel {
      if ($1 == sentinel && $3 !~ /^Z/) seen_sentinel = 1
      else seen_other = 1
    }
    END {
      exit !(invalid == 0 && seen_sentinel == 1 && seen_other == 0)
    }
  '
}

probe_parent_before_probe_group_signal() {
  :
}

terminate_owned_probe_process_group() {
  local sentinel_pid="$1"
  local ownership_file="$2"
  [[ -f "$ownership_file" ]] || return 1
  # The sentinel ignores TERM and cannot release until the parent completes
  # the success handshake. The marker is published only after this unreaped
  # direct child proves pid == pgid, so neither identity can be reused.
  probe_parent_before_probe_group_signal TERM "$sentinel_pid"
  kill -TERM -- "-${sentinel_pid}" >/dev/null 2>&1 || true
  /bin/sleep 0.1
  # The group leader is still our unreaped direct child and deliberately
  # ignores TERM. Its PID therefore cannot be reused between the first proof
  # above and this KILL, even if a later ps inspection would fail transiently.
  probe_parent_before_probe_group_signal KILL "$sentinel_pid"
  kill -KILL -- "-${sentinel_pid}" >/dev/null 2>&1 || true
}

terminate_unready_probe_sentinel() {
  local sentinel_pid="$1"
  [[ "$sentinel_pid" =~ ^[0-9]+$ ]] || return 1
  # This is an unreaped direct child, so its positive PID cannot be reused.
  # Before the start marker it is also the only process created for the probe.
  kill -KILL "$sentinel_pid" >/dev/null 2>&1 || true
}

probe_sentinel_before_ready() {
  :
}

probe_parent_after_sentinel_start() {
  :
}

probe_parent_before_ownership_proof_publication() {
  :
}

probe_parent_before_start_marker_publication() {
  :
}

probe_parent_after_sentinel_wait() {
  :
}

probe_sentinel_before_exit() {
  :
}

probe_parent_before_sentinel_release() {
  :
}

probe_child_before_command_start() {
  :
}

run_trusted_readiness_probe_with_deadline() {
  [[ "$#" -ge 2 ]] || return 125
  local probe_kind="$1"
  local timeout_seconds="$2"
  local startup_timeout_seconds profile colima_home lima_home
  startup_timeout_seconds="$(probe_startup_timeout_seconds)" || return 125
  case "$probe_kind" in
    colima-inventory)
      [[ "$#" -eq 2 ]] || return 125
      _run_readiness_probe_process_group \
        "$startup_timeout_seconds" "$timeout_seconds" colima list --json
      ;;
    lima-guest)
      [[ "$#" -eq 3 ]] || return 125
      profile="$3"
      [[ "$profile" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 125
      colima_home="${COLIMA_HOME:-${HOME}/.colima}"
      lima_home="${colima_home}/_lima"
      LIMA_HOME="$lima_home" _run_readiness_probe_process_group \
        "$startup_timeout_seconds" "$timeout_seconds" \
        limactl shell "colima-${profile}" true
      ;;
    *) return 125 ;;
  esac
}

# Private process-group primitive for the two readiness probes above. Both
# commands are fixed, trusted and non-daemonizing. Never pass a command that can
# fork, call setsid, or otherwise escape this sentinel-owned process group; a
# broader timeout needs kernel-owned isolation, not PID discovery.
_run_readiness_probe_process_group() (
  set +e
  local startup_timeout_seconds="$1"
  local timeout_seconds="$2"
  shift 2
  local probe_dir=""
  local output_file result_file result_temp_file
  local ready_file ready_temp_file start_file start_temp_file
  local command_started_file command_started_temp_file
  local ownership_file ownership_temp_file
  local settled_file settled_temp_file release_pipe
  local sentinel_pid=""
  local active_probe_state=false
  local probe_group_created=false
  local probe_reaped=false
  local started=false
  local released=false
  local cancel_result=0
  local startup_deadline_epoch deadline_epoch now_epoch
  local result=0

  write_probe_state() {
    local temp_file="$1"
    local marker_file="$2"
    : >"$temp_file" && mv "$temp_file" "$marker_file"
  }

  refresh_external_probe_cancellation() {
    if [[ -n "${SUPERVISOR_PROBE_CANCEL_FILE:-}" &&
      -f "$SUPERVISOR_PROBE_CANCEL_FILE" ]]; then
      cancel_result=143
    fi
  }

  clear_active_probe_state() {
    local attempt
    [[ "$active_probe_state" == true ]] || return 0
    for attempt in {1..20}; do
      if rmdir "$SUPERVISOR_ACTIVE_PROBE_DIR" 2>/dev/null; then
        active_probe_state=false
        return 0
      fi
      /bin/sleep 0.05
    done
    return 1
  }

  publish_probe_reaped_proof() {
    local reaped_file="${SUPERVISOR_PROBE_REAPED_FILE:-}"
    [[ -n "$reaped_file" ]] || return 0
    printf 'reaped\n' >"${reaped_file}.tmp" &&
      mv "${reaped_file}.tmp" "$reaped_file"
  }

  reset_probe_reaped_proof() {
    local reaped_file="${SUPERVISOR_PROBE_REAPED_FILE:-}"
    [[ -n "$reaped_file" ]] || return 0
    if [[ -e "$reaped_file" || -L "$reaped_file" ]]; then
      unlink "$reaped_file" || return 1
    fi
    [[ ! -e "$reaped_file" && ! -L "$reaped_file" ]]
  }

  cancel_probe_deadline() {
    cancel_result="$1"
    [[ "${sentinel_pid:-}" =~ ^[0-9]+$ ]] || return 0
    if [[ "$started" == true ]]; then
      terminate_owned_probe_process_group \
        "$sentinel_pid" "$ownership_file" || true
    else
      terminate_unready_probe_sentinel "$sentinel_pid" || true
    fi
    reap_probe_sentinel >/dev/null 2>&1 || true
  }

  reap_probe_sentinel() {
    local reaping_pid wait_result running_pid still_running
    [[ "${sentinel_pid:-}" =~ ^[0-9]+$ ]] || return 0
    reaping_pid="$sentinel_pid"
    # The direct-child identity is owned locally until wait definitively reaps
    # it. Cancellation cannot observe or signal the numeric PID after that.
    sentinel_pid=""
    while true; do
      wait "$reaping_pid"
      wait_result=$?
      still_running=false
      if (( wait_result == 130 || wait_result == 143 )); then
        for running_pid in $(jobs -p); do
          if [[ "$running_pid" == "$reaping_pid" ]]; then
            still_running=true
            break
          fi
        done
      fi
      probe_parent_after_sentinel_wait \
        "$wait_result" "$reaping_pid" "$still_running"
      if [[ "$still_running" == true ]]; then
        if (( cancel_result != 0 )); then
          if [[ "$started" == true ]]; then
            terminate_owned_probe_process_group \
              "$reaping_pid" "$ownership_file" || true
          else
            terminate_unready_probe_sentinel "$reaping_pid" || true
          fi
        fi
        continue
      fi
      probe_reaped=true
      return "$wait_result"
    done
  }

  cleanup_probe_deadline() {
    local cleanup_exit_status=$?
    trap - EXIT INT TERM
    if [[ "${sentinel_pid:-}" =~ ^[0-9]+$ ]]; then
      if [[ "$released" == false ]]; then
        if [[ "$started" == true ]]; then
          terminate_owned_probe_process_group \
            "$sentinel_pid" "$ownership_file" || true
        else
          terminate_unready_probe_sentinel "$sentinel_pid" || true
        fi
      elif probe_process_active "$sentinel_pid"; then
        printf 'release\n' >&4 || true
      fi
      reap_probe_sentinel >/dev/null 2>&1 || true
    fi
    if [[ "$probe_group_created" == false ]]; then
      probe_reaped=true
    fi
    if [[ "$probe_reaped" != true ]] || ! publish_probe_reaped_proof; then
      echo "Could not publish readiness probe reaped proof" >&2
      cleanup_exit_status=125
    fi
    exec 4>&-
    rm -f -- \
      "$output_file" "$result_file" "$result_temp_file" \
      "$ready_file" "$ready_temp_file" "$start_file" "$start_temp_file" \
      "$command_started_file" "$command_started_temp_file" \
      "$ownership_file" "$ownership_temp_file" \
      "$settled_file" "$settled_temp_file" "$release_pipe"
    rmdir "$probe_dir" 2>/dev/null || true
    if ! clear_active_probe_state; then
      echo "Could not remove active readiness probe marker" >&2
      cleanup_exit_status=125
    fi
    exit "$cleanup_exit_status"
  }

  [[ "$startup_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || return 125
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ && "$#" -gt 0 ]] || return 125
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/openshapeforge-probe.XXXXXX")" || return 125
  output_file="${probe_dir}/stdout"
  result_file="${probe_dir}/result"
  result_temp_file="${probe_dir}/result.tmp"
  ready_file="${probe_dir}/ready"
  ready_temp_file="${probe_dir}/ready.tmp"
  start_file="${probe_dir}/start"
  start_temp_file="${probe_dir}/start.tmp"
  command_started_file="${probe_dir}/command-started"
  command_started_temp_file="${probe_dir}/command-started.tmp"
  ownership_file="${probe_dir}/ownership-proven"
  ownership_temp_file="${probe_dir}/ownership-proven.tmp"
  settled_file="${probe_dir}/settled"
  settled_temp_file="${probe_dir}/settled.tmp"
  release_pipe="${probe_dir}/release.pipe"

  trap 'cancel_probe_deadline 130' INT
  trap 'cancel_probe_deadline 143' TERM
  trap cleanup_probe_deadline EXIT
  mkfifo "$release_pipe" || return 125
  # Holding both ends in the parent makes the final write non-blocking even if
  # cancellation has just reaped the sentinel FIFO reader.
  exec 4<>"$release_pipe" || return 125
  if [[ -n "${SUPERVISOR_ACTIVE_PROBE_DIR:-}" ]]; then
    if ! reset_probe_reaped_proof; then
      echo "Could not reset readiness probe reaped proof" >&2
      return 125
    fi
    mkdir "$SUPERVISOR_ACTIVE_PROBE_DIR" || return 125
    active_probe_state=true
  fi
  refresh_external_probe_cancellation
  (( cancel_result == 0 )) || return "$cancel_result"

  now_epoch="$(/bin/date +%s)" || return 125
  # /bin/date has whole-second resolution. One extra tick guarantees the
  # configured startup window is never shortened by a clock-boundary crossing.
  startup_deadline_epoch="$((now_epoch + startup_timeout_seconds + 1))"
  deadline_epoch=0
  set -m
  (
    set +e
    set +m
    # Install the sentinel's signal policy before readiness. No probe child may
    # exist until the parent has verified this process-group owner and starts it.
    trap '' INT TERM
    probe_sentinel_before_ready || exit 125
    write_probe_state "$ready_temp_file" "$ready_file" || exit 125
    while [[ ! -f "$start_file" ]]; do
      /bin/sleep 0.001
    done

    (
      exec 4>&-
      trap - INT TERM
      if ! probe_child_before_command_start; then
        result=125
      elif ! write_probe_state \
        "$command_started_temp_file" "$command_started_file"; then
        result=125
      elif "$@" >"$output_file"; then
        result=0
      else
        result=$?
      fi
      if printf '%s\n' "$result" >"$result_temp_file"; then
        mv "$result_temp_file" "$result_file"
      fi
    ) &
    local probe_child_pid=$!

    wait "$probe_child_pid" 2>/dev/null || true
    write_probe_state "$settled_temp_file" "$settled_file" || true
    local release_signal
    IFS= read -r release_signal <&4
    probe_sentinel_before_exit || exit 125
    [[ "$release_signal" == release ]]
  ) &
  sentinel_pid=$!
  probe_group_created=true
  set +m
  probe_parent_after_sentinel_start "$sentinel_pid" || {
    result=125
    terminate_unready_probe_sentinel "$sentinel_pid" || true
    reap_probe_sentinel >/dev/null 2>&1 || true
    return "$result"
  }

  while [[ ! -f "$ready_file" ]]; do
    refresh_external_probe_cancellation
    if (( cancel_result != 0 )); then
      result="$cancel_result"
      break
    fi
    if ! probe_process_active "$sentinel_pid"; then
      result=125
      break
    fi
    now_epoch="$(/bin/date +%s)" || {
      result=125
      break
    }
    if (( now_epoch >= startup_deadline_epoch )); then
      result="$PROBE_STARTUP_TIMEOUT_STATUS"
      break
    fi
    /bin/sleep 0.001
  done
  if (( result == 0 )); then
    if (( cancel_result != 0 )); then
      result="$cancel_result"
    elif ! probe_process_owns_group "$sentinel_pid"; then
      result=125
    elif ! probe_parent_before_ownership_proof_publication; then
      result=125
    elif ! write_probe_state "$ownership_temp_file" "$ownership_file"; then
      result=125
    else
      now_epoch="$(/bin/date +%s)" || result=125
      if (( result == 0 && now_epoch >= startup_deadline_epoch )); then
        result="$PROBE_STARTUP_TIMEOUT_STATUS"
      fi
      if (( result == 0 )); then
        # From this point cancellation must terminate the owned group: publishing
        # start lets the sentinel fork the probe child at any instant.
        started=true
        if ! probe_parent_before_start_marker_publication; then
          result=125
        elif (( cancel_result != 0 )); then
          result="$cancel_result"
        elif ! write_probe_state "$start_temp_file" "$start_file"; then
          if (( cancel_result != 0 )); then
            result="$cancel_result"
          else
            result=125
          fi
        elif (( cancel_result != 0 )); then
          result="$cancel_result"
        fi
      fi
    fi
  fi

  if [[ "$started" == false ]]; then
    terminate_unready_probe_sentinel "$sentinel_pid" || result=125
    reap_probe_sentinel >/dev/null 2>&1 || true
    return "$result"
  fi
  if (( result != 0 )); then
    if [[ "${sentinel_pid:-}" =~ ^[0-9]+$ ]]; then
      terminate_owned_probe_process_group \
        "$sentinel_pid" "$ownership_file" || result=125
      reap_probe_sentinel >/dev/null 2>&1 || true
    fi
    return "$result"
  fi

  while [[ ! -f "$command_started_file" ]]; do
    refresh_external_probe_cancellation
    if (( cancel_result != 0 )); then
      result="$cancel_result"
      break
    fi
    if [[ -f "$result_file" && -f "$settled_file" ]]; then
      result=125
      break
    fi
    if ! probe_process_owns_group "$sentinel_pid"; then
      result=125
      break
    fi
    now_epoch="$(/bin/date +%s)" || {
      result=125
      break
    }
    if (( now_epoch >= startup_deadline_epoch )); then
      result="$PROBE_STARTUP_TIMEOUT_STATUS"
      break
    fi
    /bin/sleep 0.001
  done

  if (( result == 0 )); then
    now_epoch="$(/bin/date +%s)" || result=125
    if (( result == 0 )); then
      # The command receives its complete configured runtime budget only after
      # the child has finished the bounded startup handshake.
      deadline_epoch="$((now_epoch + timeout_seconds + 1))"
    fi
  fi

  while (( result == 0 )); do
    refresh_external_probe_cancellation
    if (( cancel_result != 0 )); then
      result="$cancel_result"
      break
    fi
    if [[ -f "$result_file" && -f "$settled_file" ]]; then
      local command_result
      if ! IFS= read -r command_result <"$result_file" || \
        [[ ! "$command_result" =~ ^[0-9]+$ ]] || (( command_result > 255 )); then
        result=125
      elif (( command_result == 0 )); then
        result=0
      else
        # The fixed readiness commands expose only success versus failure.
        # Never let a command's raw exit status impersonate this wrapper's
        # timeout, protocol-error, or cancellation statuses.
        result="$PROBE_COMMAND_FAILURE_STATUS"
      fi
      if (( cancel_result != 0 )); then
        result="$cancel_result"
        break
      fi
      if ! probe_process_group_is_sentinel_only "$sentinel_pid"; then
        result=125
        break
      fi
      if (( cancel_result != 0 )); then
        result="$cancel_result"
        break
      fi
      probe_parent_before_sentinel_release
      if ! printf 'release\n' >&4; then
        result=125
        break
      fi
      released=true
      reap_probe_sentinel >/dev/null 2>&1 || true
      if (( cancel_result != 0 )); then
        result="$cancel_result"
      fi
      if ! cat "$output_file"; then
        result=125
      fi
      return "$result"
    fi
    if ! probe_process_owns_group "$sentinel_pid"; then
      result=125
      break
    fi
    now_epoch="$(/bin/date +%s)" || {
      result=125
      break
    }
    if (( now_epoch >= deadline_epoch )); then
      result=124
      break
    fi
    /bin/sleep 0.001
  done

  terminate_owned_probe_process_group \
    "$sentinel_pid" "$ownership_file" || result=125
  reap_probe_sentinel >/dev/null 2>&1 || true
  sentinel_pid=""
  if [[ -f "$output_file" ]] && ! cat "$output_file"; then
    result=125
  fi
  return "$result"
)

colima_profile_status() {
  local profile="$1"
  local timeout_seconds="${2:-$LIMA_READINESS_PROBE_TIMEOUT_SECONDS}"
  local profiles probe_result status
  if profiles="$(
    run_trusted_readiness_probe_with_deadline \
      colima-inventory "$timeout_seconds" 2>/dev/null
  )"; then
    probe_result=0
  else
    probe_result=$?
  fi
  if (( probe_result != 0 )); then
    if (( probe_result == PROBE_STARTUP_TIMEOUT_STATUS )); then
      echo "Colima profile inventory probe startup handshake timed out: ${profile}" >&2
    elif (( probe_result == 124 )); then
      echo "Colima profile inventory probe timed out: ${profile}" >&2
    fi
    echo "Could not inspect Colima profile ${profile}" >&2
    return "$probe_result"
  fi
  if ! status="$(
    printf '%s\n' "$profiles" | jq -ser --arg profile "$profile" '
      if all(.[];
        type == "object" and
        ((.name | type) == "string") and
        ((.name | length) > 0) and
        ((.status | type) == "string") and
        ((.status | length) > 0))
      then
        [.[] | select(.name == $profile)] as $matches |
        if ($matches | length) == 0 then "Absent"
        elif ($matches | length) == 1 then $matches[0].status
        else error("duplicate Colima profile")
        end
      else error("invalid Colima profile inventory")
      end
    '
  )"; then
    echo "Could not verify Colima profile ${profile}" >&2
    return 1
  fi
  printf '%s\n' "$status"
}

lima_guest_ready() {
  local profile="$1"
  local timeout_seconds="${2:-$LIMA_READINESS_PROBE_TIMEOUT_SECONDS}"
  run_trusted_readiness_probe_with_deadline \
    lima-guest "$timeout_seconds" "$profile" >/dev/null 2>&1
}

# Lima 2.2 has no Starting state: a running driver without its late hostagent
# is Broken until the hostagent becomes reachable. Bound that transient state
# and guest startup; only exact-profile Running plus exact-instance shell works.
wait_for_late_lima_start() {
  local profile="$1"
  local probe_timeout_seconds="${2:-$LIMA_READINESS_PROBE_TIMEOUT_SECONDS}"
  local instance="colima-${profile}"
  local attempt attempt_limit probe_result status
  attempt_limit="$(late_lima_start_attempt_limit)" || return 125
  [[ "$attempt_limit" =~ ^[1-9][0-9]*$ ]] || return 125
  for ((attempt = 1; attempt <= attempt_limit; attempt += 1)); do
    if status="$(colima_profile_status "$profile" "$probe_timeout_seconds")"; then
      probe_result=0
    else
      probe_result=$?
    fi
    (( probe_result == 0 )) || return "$probe_result"
    case "$status" in
      Running)
        if lima_guest_ready "$profile" "$probe_timeout_seconds"; then
          probe_result=0
        else
          probe_result=$?
        fi
        (( probe_result == 0 )) && return 0
        if (( probe_result == PROBE_STARTUP_TIMEOUT_STATUS )); then
          echo "Late Lima guest probe startup handshake timed out: ${instance}" >&2
          return "$probe_result"
        fi
        if (( probe_result == 124 )); then
          echo "Late Lima guest probe timed out: ${instance}" >&2
          return "$probe_result"
        fi
        if (( probe_result == 130 || probe_result == 143 )); then
          return "$probe_result"
        fi
        if (( attempt < attempt_limit )); then
          sleep "$LATE_LIMA_START_INTERVAL_SECONDS"
          continue
        fi
        echo "Late Lima instance did not become guest-ready: ${instance}" >&2
        return 1
        ;;
      Broken)
        if (( attempt < attempt_limit )); then
          sleep "$LATE_LIMA_START_INTERVAL_SECONDS"
          continue
        fi
        ;;
      Stopped|Absent)
        echo \
          "Colima profile ${profile} cannot complete the failed Lima start from state ${status}" \
          >&2
        return 1
        ;;
      *)
        echo \
          "Colima profile ${profile} reported unexpected state after failed Lima start: ${status}" \
          >&2
        return 1
        ;;
    esac
  done
  echo "Colima profile ${profile} stayed Broken after the failed Lima start" >&2
  return 1
}

run_configured_colima_start() {
  local profile="$1"
  colima start "$profile" \
    --cpus 6 --memory 14 --root-disk 120 --arch aarch64 --runtime docker \
    --vm-type vz --vz-rosetta --binfmt --mount none --ssh-agent=false --ssh-config=false \
    --activate=false --port-forwarder none \
    --dns 1.1.1.1 --dns 1.0.0.1 >/dev/null
}

start_colima_profile() {
  local profile="$1"
  local colima_home="${COLIMA_HOME:-${HOME}/.colima}"
  local lima_home="${colima_home}/_lima"
  local instance="colima-${profile}"

  if run_configured_colima_start "$profile"; then
    return 0
  fi
  wait_for_late_lima_start "$profile" || return 1

  # Colima 0.10.x ignores start while Lima is already running. Stop only the
  # exact late instance so the identical retry must finish Colima's runtime
  # provisioning instead of treating Lima's Running state as completion.
  if ! LIMA_HOME="$lima_home" limactl stop "$instance" >/dev/null; then
    echo "Could not stop late Lima instance for Colima completion: ${instance}" >&2
    return 1
  fi
  if ! run_configured_colima_start "$profile"; then
    echo "Colima runtime provisioning did not complete after late Lima start: ${profile}" >&2
    return 1
  fi
  echo "Completed Colima provisioning after late Lima start for ${profile}" >&2
}

path_owner_uid() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

require_owned_directory() {
  local path="$1"
  local owner
  if [[ -L "$path" || ! -d "$path" ]]; then
    echo "Broken profile recovery requires a real directory: ${path}" >&2
    return 1
  fi
  if ! owner="$(path_owner_uid "$path" 2>/dev/null)"; then
    echo "Could not verify recovery path ownership: ${path}" >&2
    return 1
  fi
  if [[ "$owner" != "$RUNNER_UID" ]]; then
    echo "Refusing recovery of a foreign-owned path: ${path}" >&2
    return 1
  fi
}

require_disposable_profile_tree() {
  local path="$1"
  local unexpected
  require_owned_directory "$path" || return 1
  if ! unexpected="$(find -P "$path" -type l -print -quit 2>/dev/null)"; then
    echo "Could not inspect recovery tree for symlinks: ${path}" >&2
    return 1
  fi
  if [[ -n "$unexpected" ]]; then
    echo "Refusing recovery of a tree containing symlinks: ${path}" >&2
    return 1
  fi
  if ! unexpected="$(find -P "$path" ! -user "$RUNNER_USER" -print -quit 2>/dev/null)"; then
    echo "Could not inspect recovery tree ownership: ${path}" >&2
    return 1
  fi
  if [[ -n "$unexpected" ]]; then
    echo "Refusing recovery of a tree containing foreign-owned state: ${path}" >&2
    return 1
  fi
}

recover_broken_ephemeral_profile() {
  local profile="$1"
  local colima_home="${HOME}/.colima"
  local configured_colima_home="${COLIMA_HOME-${colima_home}}"
  local lima_home="${colima_home}/_lima"
  local configured_lima_home="${LIMA_HOME-}"
  local profile_state="${colima_home}/${BROKEN_RECOVERY_PROFILE}"
  local lima_state="${lima_home}/colima-${BROKEN_RECOVERY_PROFILE}"
  local lima_config="${lima_state}/lima.yaml"

  if [[ "$profile" != "$BROKEN_RECOVERY_PROFILE" ]]; then
    echo "Refusing Broken recovery outside ${BROKEN_RECOVERY_PROFILE}: ${profile}" >&2
    return 1
  fi
  case "$HOME" in
    /*) ;;
    *)
      echo "Refusing Broken recovery with a non-absolute HOME" >&2
      return 1
      ;;
  esac
  case "$HOME" in
    /|*/|*/../*|*/..|*/./*|*/.)
      echo "Refusing Broken recovery with an unexpected HOME path" >&2
      return 1
      ;;
  esac
  if [[ "$configured_colima_home" != "$colima_home" ]]; then
    echo "Refusing Broken recovery with an unexpected COLIMA_HOME" >&2
    return 1
  fi
  if [[ -n "$configured_lima_home" && "$configured_lima_home" != "$lima_home" ]]; then
    echo "Refusing Broken recovery with an unexpected LIMA_HOME" >&2
    return 1
  fi

  require_owned_directory "$HOME" || return 1
  require_owned_directory "$colima_home" || return 1
  require_owned_directory "$lima_home" || return 1
  if [[ -e "$lima_config" || -L "$lima_config" ]]; then
    echo "Refusing Broken recovery when lima.yaml is present or linked" >&2
    return 1
  fi
  require_disposable_profile_tree "$profile_state" || return 1
  require_disposable_profile_tree "$lima_state" || return 1

  if ! rm -rf -- "$profile_state" "$lima_state"; then
    echo "Could not remove disposable state for ${BROKEN_RECOVERY_PROFILE}" >&2
    return 1
  fi
  if [[ -e "$profile_state" || -L "$profile_state" || -e "$lima_state" || -L "$lima_state" ]]; then
    echo "Disposable state for ${BROKEN_RECOVERY_PROFILE} still exists after recovery" >&2
    return 1
  fi
}

delete_profile() {
  local profile="$1"
  local status
  status="$(colima_profile_status "$profile")" || return 1
  if [[ "$status" != "Absent" ]]; then
    if [[ "$status" == "Broken" ]]; then
      recover_broken_ephemeral_profile "$profile" || return 1
      status="$(colima_profile_status "$BROKEN_RECOVERY_PROFILE")" || return 1
      if [[ "$status" != "Absent" ]]; then
        echo "Colima profile ${BROKEN_RECOVERY_PROFILE} still exists after recovery" >&2
        return 1
      fi
      return 0
    fi
    if [[ "$status" != "Stopped" ]]; then
      colima stop -p "$profile" >/dev/null 2>&1 || true
    fi
    if ! colima delete -p "$profile" --force >/dev/null; then
      echo "Could not delete Colima profile ${profile}" >&2
      return 1
    fi
  fi
  status="$(colima_profile_status "$profile")" || return 1
  if [[ "$status" != "Absent" ]]; then
    echo "Colima profile ${profile} still exists after deletion" >&2
    return 1
  fi
  return 0
}

cleanup_slot() {
  local slot="$1"
  local prefix busy
  prefix="$(runner_prefix_for "$slot")"
  if ! busy="$(
    gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
      --jq ".runners[] | select(.name | startswith(\"${prefix}\")) | select(.busy == true) | .name"
  )"; then
    echo "Could not verify runner state for slot ${slot}; refusing cleanup" >&2
    return 1
  fi
  if [[ -n "$busy" ]]; then
    echo "Refusing to delete busy runner slot ${slot}: ${busy}" >&2
    return 1
  fi
  delete_matching_runners "$prefix" || return 1
  delete_profile "$(profile_for "$slot")" || return 1
  return 0
}

disable_local_deploy_runner() {
  delete_matching_runners "$DISABLED_DEPLOY_RUNNER_PREFIX"
  delete_profile "osf-deploy"
}

ensure_runner_archive() {
  mkdir -p "$SUPPORT_DIR"
  if [[ -f "$RUNNER_ARCHIVE" ]] &&
    [[ "$(shasum -a 256 "$RUNNER_ARCHIVE" | cut -d ' ' -f 1)" == "$RUNNER_SHA256" ]]; then
    return
  fi

  local partial="${RUNNER_ARCHIVE}.partial"
  curl -fsSLo "$partial" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz"
  [[ "$(shasum -a 256 "$partial" | cut -d ' ' -f 1)" == "$RUNNER_SHA256" ]] || {
    echo "Runner archive checksum mismatch" >&2
    exit 1
  }
  mv "$partial" "$RUNNER_ARCHIVE"
}

verify_fresh_vm() {
  local profile="$1"
  colima -p "$profile" ssh -- env HOST_HOME="$HOME" bash -lc '
    set -euo pipefail
    test ! -e "$HOST_HOME"
    test "$(uname -m)" = aarch64
    command -v curl git mvn node npx wget unzip zstd jq pgrep visudo iptables ip6tables dockerd-rootless-setuptool.sh >/dev/null
    ! dmesg --level=err 2>/dev/null | grep -Eq "I/O error|EXT4-fs error|Aborting journal"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
    docker info --format "{{json .SecurityOptions}}" | grep -q rootless
    docker pull alpine:3.20 >/dev/null
    docker pull busybox:1.36.1 >/dev/null
    docker run --rm alpine:3.20 true
    service_name="osf-rootless-published-$$"
    peer_name="osf-rootless-peer-$$"
    network_name="osf-rootless-network-$$"
    trap "docker rm -f $service_name $peer_name >/dev/null 2>&1 || true; docker network rm $network_name >/dev/null 2>&1 || true" EXIT
    docker run -d --name "$service_name" -p 49300:49300 busybox:1.36.1 \
      sh -c "mkdir -p /www && echo ready >/www/index.html && httpd -f -p 49300 -h /www" >/dev/null
    for attempt in {1..20}; do
      wget -qO- http://127.0.0.1:49300 | grep -qx ready && break
      sleep 0.25
    done
    wget -qO- http://127.0.0.1:49300 | grep -qx ready
    docker network create "$network_name" >/dev/null
    docker run -d --name "$peer_name" --network "$network_name" busybox:1.36.1 \
      sh -c "mkdir -p /www && echo ready >/www/index.html && httpd -f -p 49301 -h /www" >/dev/null
    for attempt in {1..20}; do
      docker run --rm --network "$network_name" busybox:1.36.1 \
        wget -qO- "http://${peer_name}:49301" | grep -qx ready && break
      sleep 0.25
    done
    docker run --rm --network "$network_name" busybox:1.36.1 \
      wget -qO- "http://${peer_name}:49301" | grep -qx ready
    docker rm -f "$service_name" >/dev/null
    docker rm -f "$peer_name" >/dev/null
    docker network rm "$network_name" >/dev/null
    builder="osf-provision-$$"
    trap "docker buildx rm --force $builder >/dev/null 2>&1 || true; docker rm -f $service_name $peer_name >/dev/null 2>&1 || true; docker network rm $network_name >/dev/null 2>&1 || true" EXIT
    docker buildx create --name "$builder" --driver docker-container --use >/dev/null
    docker buildx inspect --bootstrap "$builder" >/dev/null
    root_kib="$(df -Pk / | tail -1 | tr -s " " | cut -d " " -f 2)"
    (( root_kib >= 100 * 1024 * 1024 ))
  '
}

# Colima treats Rosetta and QEMU binfmt registration failures as warnings, so
# configuration alone is not admission proof. Exercise the rootless Docker path
# that the canonical image smoke jobs use before an untrusted runner registers.
verify_cross_architecture_container_execution() {
  local profile="$1"
  colima -p "$profile" ssh -- bash -lc '
    set -euo pipefail
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
    preflight_image="alpine:3.20"
    restore_native_image() {
      docker pull --platform linux/arm64 "$preflight_image" >/dev/null
    }
    trap "restore_native_image || true" EXIT

    docker pull --platform linux/amd64 "$preflight_image" >/dev/null
    if ! pulled_platform="$(
      docker image inspect --platform linux/amd64 \
        --format "{{.Os}}/{{.Architecture}}" "$preflight_image"
    )"; then
      echo "Runner pre-admission cannot inspect the linux/amd64 container image" >&2
      exit 1
    fi
    [[ "$pulled_platform" == linux/amd64 ]] || {
      echo "Runner pre-admission pulled an unexpected container platform: ${pulled_platform}" >&2
      exit 1
    }
    if ! executed_architecture="$(
      docker run --rm --platform linux/amd64 "$preflight_image" /bin/uname -m
    )"; then
      echo "Runner pre-admission cannot execute linux/amd64 containers" >&2
      exit 1
    fi
    [[ "$executed_architecture" == x86_64 ]] || {
      echo "Runner pre-admission executed an unexpected container architecture: ${executed_architecture}" >&2
      exit 1
    }

    restore_native_image
    trap - EXIT
  '
}

# PR code must not be able to probe services on the Mac or its LAN. Keep
# loopback and DNS through the VM gateway, then reject every IANA non-global
# IPv4 range and all IPv6. Rootless Docker egress is generated by an unprivileged
# guest process and traverses OUTPUT too. Public registry and GitHub traffic
# remains available and is exercised by verify_fresh_vm.
isolate_runner_network() {
  local profile="$1"
  colima -p "$profile" ssh -- bash -lc '
    set -euo pipefail
    gateway="$(ip -4 route show default | awk "NR == 1 { print \$3 }")"
    [[ "$gateway" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]

    sudo iptables -N OSF_RUNNER_EGRESS 2>/dev/null || sudo iptables -F OSF_RUNNER_EGRESS
    sudo iptables -C OUTPUT -j OSF_RUNNER_EGRESS 2>/dev/null ||
      sudo iptables -I OUTPUT 1 -j OSF_RUNNER_EGRESS
    sudo iptables -A OSF_RUNNER_EGRESS -o lo -j RETURN
    sudo iptables -A OSF_RUNNER_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    sudo iptables -A OSF_RUNNER_EGRESS -d "$gateway/32" -p udp --dport 53 -j RETURN
    sudo iptables -A OSF_RUNNER_EGRESS -d "$gateway/32" -p tcp --dport 53 -j RETURN
    for cidr in \
      0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
      169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 \
      192.31.196.0/24 192.52.193.0/24 192.88.99.0/24 192.168.0.0/16 \
      192.175.48.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 \
      224.0.0.0/4 240.0.0.0/4; do
      sudo iptables -A OSF_RUNNER_EGRESS -d "$cidr" -j REJECT
    done
    sudo iptables -A OSF_RUNNER_EGRESS -j RETURN

    sudo ip6tables -N OSF_RUNNER_EGRESS_V6 2>/dev/null || sudo ip6tables -F OSF_RUNNER_EGRESS_V6
    sudo ip6tables -C OUTPUT -j OSF_RUNNER_EGRESS_V6 2>/dev/null ||
      sudo ip6tables -I OUTPUT 1 -j OSF_RUNNER_EGRESS_V6
    sudo ip6tables -A OSF_RUNNER_EGRESS_V6 -o lo -j RETURN
    sudo ip6tables -A OSF_RUNNER_EGRESS_V6 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    sudo ip6tables -A OSF_RUNNER_EGRESS_V6 -j REJECT
  '
}

setup_rootless_docker() {
  local profile="$1"
  colima -p "$profile" ssh -- env RUNNER_USER="$RUNNER_USER" bash -lc '
    set -euo pipefail
    sudo apt-get install -y uidmap slirp4netns dbus-user-session docker-ce-rootless-extras fuse-overlayfs >/dev/null
    sudo loginctl enable-linger "$RUNNER_USER"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    dockerd-rootless-setuptool.sh install --force >/dev/null
    systemctl --user start docker.service
    export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
    docker info --format "{{json .SecurityOptions}}" | grep -q rootless
  '
}

install_pre_job_policy() {
  local profile="$1"
  local approved_workflow_shas="$2"
  validate_workflow_sha_allow_list "$approved_workflow_shas" || {
    echo "Refusing to install an invalid workflow SHA allow-list" >&2
    return 1
  }
  printf '%s\n' "$approved_workflow_shas" | colima -p "$profile" ssh -- bash -lc '
    set -euo pipefail
    sudo install -d -o root -g root -m 0755 /opt/openshapeforge-runner
    sudo tee /opt/openshapeforge-runner/pre-job-policy.sh >/dev/null <<'"'"'POLICY'"'"'
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

/usr/bin/env -i /usr/bin/jq -e --arg repository "$EXPECTED_REPOSITORY" '"'"'
  .repository.full_name == $repository and
  .pull_request.base.repo.full_name == $repository and
  .pull_request.head.repo.full_name == $repository and
  .pull_request.head.repo.fork == false
'"'"' "$GITHUB_EVENT_PATH" >/dev/null || deny

echo "Self-hosted runner policy accepted an approved same-repository pull request route."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
POLICY
    sudo chown root:root /opt/openshapeforge-runner/pre-job-policy.sh
    sudo chmod 0755 /opt/openshapeforge-runner/pre-job-policy.sh
    sudo tee /opt/openshapeforge-runner/approved-workflow-shas >/dev/null
    sudo chown root:root /opt/openshapeforge-runner/approved-workflow-shas
    sudo chmod 0444 /opt/openshapeforge-runner/approved-workflow-shas
  '
}

install_runner_service() {
  local profile="$1"
  local service="$2"
  colima -p "$profile" ssh -- env RUNNER_SERVICE="$service" RUNNER_USER="$RUNNER_USER" bash -lc '
    set -euo pipefail
    cd /opt/actions-runner
    runner_uid="$(id -u "$RUNNER_USER")"
    sudo ./svc.sh install "$RUNNER_USER" >/dev/null
    sudo install -d -o root -g root -m 0755 "/etc/systemd/system/${RUNNER_SERVICE}.d"
    printf "%s\n" \
      "[Service]" \
      "Environment=XDG_RUNTIME_DIR=/run/user/${runner_uid}" \
      "Environment=DOCKER_HOST=unix:///run/user/${runner_uid}/docker.sock" \
      "Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/openshapeforge-runner/pre-job-policy.sh" \
      "ExecStartPre=+/usr/bin/rm -f /etc/sudoers.d/openshapeforge-runner-start" |
      sudo tee "/etc/systemd/system/${RUNNER_SERVICE}.d/rootless-docker.conf" >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl disable "$RUNNER_SERVICE" >/dev/null
  '
}

harden_runner_before_start() {
  local profile="$1"
  local service="$2"
  colima -p "$profile" ssh -- env RUNNER_SERVICE="$service" RUNNER_USER="$RUNNER_USER" bash -lc '
    set -euo pipefail
    sudo env RUNNER_SERVICE="$RUNNER_SERVICE" RUNNER_USER="$RUNNER_USER" bash -lc '\''
      set -euo pipefail
      systemctl stop docker.service docker.socket containerd.service >/dev/null 2>&1 || true
      systemctl disable docker.service docker.socket containerd.service >/dev/null 2>&1 || true
      systemctl mask docker.service docker.socket containerd.service >/dev/null
      gpasswd -d "$RUNNER_USER" docker >/dev/null 2>&1 || true
      rm -f /var/run/docker.sock
      rm -f /etc/sudoers.d/90-cloud-init-users
      printf "%s ALL=(root) NOPASSWD: /usr/bin/systemctl start %s\n" \
        "$RUNNER_USER" "$RUNNER_SERVICE" >/etc/sudoers.d/openshapeforge-runner-start
      chmod 0440 /etc/sudoers.d/openshapeforge-runner-start
      visudo -cf /etc/sudoers.d/openshapeforge-runner-start >/dev/null
    '\''
  '
}

start_runner_service() {
  local profile="$1"
  local service="$2"
  colima -p "$profile" ssh -- env RUNNER_SERVICE="$service" bash -lc '
    set -euo pipefail
    sudo -n /usr/bin/systemctl start "$RUNNER_SERVICE"
    [[ "$(systemctl is-active "$RUNNER_SERVICE" 2>/dev/null || true)" == "active" ]] || {
      echo "Runner service did not become active" >&2
      exit 1
    }
    test ! -e /etc/sudoers.d/openshapeforge-runner-start || {
      echo "Runner start authorization was not consumed" >&2
      exit 1
    }
  '
}

verify_pre_job_policy() {
  local profile="$1"
  local service="$2"
  colima -p "$profile" ssh -- env RUNNER_SERVICE="$service" bash -lc '
    set -euo pipefail
    hook=/opt/openshapeforge-runner/pre-job-policy.sh
    allow_list=/opt/openshapeforge-runner/approved-workflow-shas
    [[ "$(stat -c "%u:%g:%a" "$hook")" == "0:0:755" ]] || {
      echo "Pre-job policy is not root-owned and executable" >&2
      exit 1
    }
    [[ -f "$allow_list" && ! -L "$allow_list" ]] || {
      echo "Workflow SHA allow-list is not a regular root-controlled file" >&2
      exit 1
    }
    [[ "$(stat -c "%u:%g:%a" "$allow_list")" == "0:0:444" ]] || {
      echo "Workflow SHA allow-list is not root-owned and world-readable" >&2
      exit 1
    }
    approved_workflow_sha="$(sed -n "1p" "$allow_list")"
    [[ "$approved_workflow_sha" =~ ^[0-9a-f]{40}$ ]] || {
      echo "Workflow SHA allow-list is empty or malformed" >&2
      exit 1
    }
    systemctl show "$RUNNER_SERVICE" -p Environment --value |
      grep -Fq "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook" || {
        echo "Runner service does not enforce the pre-job policy" >&2
        exit 1
      }
    policy_fixtures="$(mktemp -d)"
    trap "rm -rf $policy_fixtures" EXIT
    printf "%s\n" '"'"'{"repository":{"full_name":"OpenShapeForge/OpenShapeForge"},"pull_request":{"base":{"repo":{"full_name":"OpenShapeForge/OpenShapeForge"}},"head":{"repo":{"full_name":"OpenShapeForge/OpenShapeForge","fork":false}}}}'"'"' >"$policy_fixtures/same-repo.json"
    printf "%s\n" '"'"'{"repository":{"full_name":"OpenShapeForge/OpenShapeForge"},"pull_request":{"base":{"repo":{"full_name":"OpenShapeForge/OpenShapeForge"}},"head":{"repo":{"full_name":"contributor/OpenShapeForge","fork":true}}}}'"'"' >"$policy_fixtures/fork.json"
    env GITHUB_EVENT_NAME=pull_request \
      GITHUB_JOB=gates \
      GITHUB_REPOSITORY=OpenShapeForge/OpenShapeForge \
      GITHUB_EVENT_PATH="$policy_fixtures/same-repo.json" \
      GITHUB_WORKFLOW_REF=OpenShapeForge/OpenShapeForge/.github/workflows/ci.yml@refs/pull/1/merge \
      GITHUB_WORKFLOW_SHA="$approved_workflow_sha" \
      "$hook" >/dev/null
    if env GITHUB_EVENT_NAME=pull_request \
      GITHUB_JOB=gates \
      GITHUB_REPOSITORY=OpenShapeForge/OpenShapeForge \
      GITHUB_EVENT_PATH="$policy_fixtures/fork.json" \
      GITHUB_WORKFLOW_REF=OpenShapeForge/OpenShapeForge/.github/workflows/ci.yml@refs/pull/1/merge \
      GITHUB_WORKFLOW_SHA="$approved_workflow_sha" \
      "$hook" >/dev/null 2>&1; then
      echo "Pre-job policy accepted a fork pull request" >&2
      exit 1
    fi
    if env GITHUB_EVENT_NAME=pull_request \
      GITHUB_JOB=group-only \
      GITHUB_REPOSITORY=OpenShapeForge/OpenShapeForge \
      GITHUB_EVENT_PATH="$policy_fixtures/same-repo.json" \
      GITHUB_WORKFLOW_REF=OpenShapeForge/OpenShapeForge/.github/workflows/ci.yml@refs/pull/1/merge \
      GITHUB_WORKFLOW_SHA="$approved_workflow_sha" \
      "$hook" >/dev/null 2>&1; then
      echo "Pre-job policy accepted an unapproved workflow route" >&2
      exit 1
    fi
    if env GITHUB_EVENT_NAME=pull_request \
      GITHUB_JOB=gates \
      GITHUB_REPOSITORY=OpenShapeForge/OpenShapeForge \
      GITHUB_EVENT_PATH="$policy_fixtures/same-repo.json" \
      GITHUB_WORKFLOW_REF=OpenShapeForge/OpenShapeForge/.github/workflows/ci.yml@refs/pull/1/merge \
      GITHUB_WORKFLOW_SHA=0000000000000000000000000000000000000000 \
      "$hook" >/dev/null 2>&1; then
      echo "Pre-job policy accepted a workflow SHA outside its host snapshot" >&2
      exit 1
    fi
    rm -rf "$policy_fixtures"
    trap - EXIT
  '
}

verify_unprivileged_runner() {
  local profile="$1"
  local service="$2"
  colima -p "$profile" ssh -- env RUNNER_SERVICE="$service" RUNNER_USER="$RUNNER_USER" bash -lc '
    set -euo pipefail
    if [[ "$(systemctl is-enabled "$RUNNER_SERVICE" 2>/dev/null || true)" != "disabled" ]]; then
      echo "Runner service would restart without the runtime firewall" >&2
      exit 1
    fi
    if [[ "$(systemctl is-active "$RUNNER_SERVICE" 2>/dev/null || true)" != "inactive" ]]; then
      echo "Runner service started before admission" >&2
      exit 1
    fi
    if pgrep -f "^/opt/actions-runner/bin/Runner.Listener( |$)" >/dev/null; then
      echo "Runner listener exists before admission" >&2
      exit 1
    fi
    if sudo -n true >/dev/null 2>&1; then
      echo "Runner user still has passwordless sudo" >&2
      exit 1
    fi
    if id -nG "$RUNNER_USER" | tr " " "\n" | grep -qx docker; then
      echo "Runner user still belongs to the rootful docker group" >&2
      exit 1
    fi
    test ! -S /var/run/docker.sock
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
    docker info --format "{{json .SecurityOptions}}" | grep -q rootless
    if iptables -F >/dev/null 2>&1 || ip route replace 203.0.113.1/32 via 192.168.5.2 >/dev/null 2>&1; then
      echo "Runner user can still alter the guest network boundary" >&2
      exit 1
    fi
    service_user="$(systemctl show "$RUNNER_SERVICE" -p User --value)"
    [[ "$service_user" == "$RUNNER_USER" ]] || {
      echo "Runner service does not use the isolated runner user" >&2
      exit 1
    }
    service_group="$(systemctl show "$RUNNER_SERVICE" -p Group --value)"
    if [[ -n "$service_group" && "$service_group" != "$(id -gn "$RUNNER_USER")" ]]; then
      echo "Runner service uses an unexpected primary group" >&2
      exit 1
    fi
    [[ -z "$(systemctl show "$RUNNER_SERVICE" -p SupplementaryGroups --value)" ]] || {
      echo "Runner service has supplementary groups" >&2
      exit 1
    }
  '
}

verify_host_network_boundary() {
  local profile="$1"
  local address group_id hostagent_gid hostagent_pid
  address="$(
    colima list --json 2>/dev/null |
      jq -r --arg profile "$profile" 'select(.name == $profile) | .address // empty'
  )"
  [[ -z "$address" ]] || {
    echo "Runner VM unexpectedly has a host-reachable address: ${address}" >&2
    return 1
  }
  hostagent_pid="$(cat "${HOME}/.colima/_lima/colima-${profile}/ha.pid" 2>/dev/null || true)"
  [[ "$hostagent_pid" =~ ^[0-9]+$ ]] || {
    echo "Could not identify the Colima host agent" >&2
    return 1
  }
  hostagent_gid="$(ps -o gid= -p "$hostagent_pid" | tr -d ' ')"
  group_id="$(dscl . -read "/Groups/${ISOLATION_GROUP}" PrimaryGroupID 2>/dev/null | awk '{ print $2 }')"
  [[ "$group_id" =~ ^[0-9]+$ && "$hostagent_gid" == "$group_id" ]] || {
    echo "Colima host agent is outside the PF isolation group" >&2
    return 1
  }
}

host_tcp_port_state() {
  local port="$1"
  local listener_error_file listener_output listener_status=0
  if ! listener_error_file="$(mktemp "${TMPDIR:-/tmp}/openshapeforge-lsof.XXXXXX")"; then
    printf 'error\n'
    return 0
  fi
  if listener_output="$(lsof -nP -a -iTCP:"$port" -sTCP:LISTEN 2>"$listener_error_file")"; then
    listener_status=0
  else
    listener_status=$?
  fi
  if (( listener_status == 0 )) && [[ -n "$listener_output" ]]; then
    printf 'bound\n'
  elif (( listener_status == 1 )) && [[ -z "$listener_output" && ! -s "$listener_error_file" ]]; then
    printf 'unbound\n'
  else
    printf 'error\n'
  fi
  rm -f "$listener_error_file"
}

assert_host_tcp_port_unbound() {
  local port="$1"
  local state
  state="$(host_tcp_port_state "$port")"
  case "$state" in
    unbound) return 0 ;;
    bound)
      echo "TCP port ${port} is bound on the Mac; forwarding proof cannot continue" >&2
      ;;
    *) echo "Could not prove that TCP port ${port} is unbound on the Mac" >&2 ;;
  esac
  return 1
}

select_forwarding_probe_port() {
  local first_port="${1:-49152}"
  local port state
  for ((port = first_port; port <= 49279; port += 1)); do
    state="$(host_tcp_port_state "$port")"
    case "$state" in
      unbound)
        printf '%s\n' "$port"
        return 0
        ;;
      bound) ;;
      *)
        echo "Could not inspect candidate forwarding probe ports on the Mac" >&2
        return 1
        ;;
    esac
  done
  echo "Could not find an unbound forwarding probe port on the Mac" >&2
  return 1
}

# Colima 0.10.x's `none` rule covers wildcard listeners but Lima's implicit
# loopback rule has higher specificity. Stop the still-trusted VM, add explicit
# deny rules to its generated Lima config, validate it, and only then restart.
harden_colima_loopback_forwarding() {
  local profile="$1"
  local colima_home="${COLIMA_HOME:-${HOME}/.colima}"
  local lima_home="${colima_home}/_lima"
  local instance="colima-${profile}"
  local config="${lima_home}/${instance}/lima.yaml"
  local temp_config

  LIMA_HOME="$lima_home" limactl stop "$instance" >/dev/null
  [[ -f "$config" ]] || {
    echo "Generated Lima config is missing for ${profile}" >&2
    return 1
  }
  [[ "$(grep -c '^portForwards:$' "$config")" == 1 ]] || {
    echo "Generated Lima forwarding config is not in the expected shape" >&2
    return 1
  }

  temp_config="$(mktemp "${config}.tmp.XXXXXX")"
  if ! awk '
    /^portForwards:$/ {
      print
      print "    - guestIP: 127.0.0.1"
      print "      guestPortRange:"
      print "        - 1"
      print "        - 65535"
      print "      hostPortRange:"
      print "        - 1"
      print "        - 65535"
      print "      proto: any"
      print "      ignore: true"
      print "    - guestIP: ::1"
      print "      guestPortRange:"
      print "        - 1"
      print "        - 65535"
      print "      hostPortRange:"
      print "        - 1"
      print "        - 65535"
      print "      proto: any"
      print "      ignore: true"
      next
    }
    { print }
  ' "$config" >"$temp_config"; then
    rm -f "$temp_config"
    return 1
  fi
  chmod 0600 "$temp_config"
  if ! LIMA_HOME="$lima_home" limactl validate "$temp_config" >/dev/null; then
    rm -f "$temp_config"
    echo "Hardened Lima forwarding config is invalid" >&2
    return 1
  fi
  mv "$temp_config" "$config"
  if ! LIMA_HOME="$lima_home" limactl start --tty=false "$instance" >/dev/null; then
    wait_for_late_lima_start "$profile" || return 1
    echo "Verified late Lima start for ${instance}" >&2
  fi
}

# Colima is configured with no port forwarder, but admission also proves that
# behavior live. Keep wildcard, IPv4-loopback and IPv6-loopback guest listeners
# alive while the Mac checks both loopback families and its complete listener
# table, then tear them down before a registration token is requested.
verify_guest_port_forwarding_disabled() {
  local profile="$1"
  local attempt port result=0
  local wildcard_probe_port ipv4_loopback_probe_port ipv6_loopback_probe_port

  wildcard_probe_port="$(select_forwarding_probe_port)" || return 1
  ipv4_loopback_probe_port="$(select_forwarding_probe_port "$((wildcard_probe_port + 1))")" || return 1
  ipv6_loopback_probe_port="$(select_forwarding_probe_port "$((ipv4_loopback_probe_port + 1))")" || return 1
  assert_host_tcp_port_unbound "$wildcard_probe_port" || return 1
  assert_host_tcp_port_unbound "$ipv4_loopback_probe_port" || return 1
  assert_host_tcp_port_unbound "$ipv6_loopback_probe_port" || return 1
  if ! colima -p "$profile" ssh -- env \
    WILDCARD_PROBE_PORT="$wildcard_probe_port" \
    IPV4_LOOPBACK_PROBE_PORT="$ipv4_loopback_probe_port" \
    IPV6_LOOPBACK_PROBE_PORT="$ipv6_loopback_probe_port" bash -lc '
    set -euo pipefail
    readonly pid_file=/tmp/openshapeforge-forwarding-probe.pid
    readonly ready_file=/tmp/openshapeforge-forwarding-probe.ready
    readonly log_file=/tmp/openshapeforge-forwarding-probe.log
    probe_ready=0
    rm -f "$pid_file" "$ready_file" "$log_file"
    [[ -x /usr/local/bin/node ]]
    nohup /usr/local/bin/node -e '"'"'
      const fs = require("node:fs");
      const net = require("node:net");
      const probes = [
        [Number(process.env.WILDCARD_PROBE_PORT), "0.0.0.0"],
        [Number(process.env.IPV4_LOOPBACK_PROBE_PORT), "127.0.0.1"],
        [Number(process.env.IPV6_LOOPBACK_PROBE_PORT), "::1"],
      ];
      let ready = 0;
      for (const [port, host] of probes) {
        const server = net.createServer((socket) => {
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nready\n");
        });
        server.listen(port, host, () => {
          ready += 1;
          if (ready === probes.length) {
            fs.writeFileSync("/tmp/openshapeforge-forwarding-probe.ready", "ready\n", { mode: 0o600 });
          }
        });
      }
    '"'"' >"$log_file" 2>&1 </dev/null &
    printf "%s\n" "$!" >"$pid_file"
    for attempt in {1..20}; do
      if [[ -f "$ready_file" ]]; then
        wildcard_response="$(curl -fsS --max-time 1 \
          "http://127.0.0.1:${WILDCARD_PROBE_PORT}" 2>>"$log_file" || true)"
        ipv4_response="$(curl -fsS --max-time 1 \
          "http://127.0.0.1:${IPV4_LOOPBACK_PROBE_PORT}" 2>>"$log_file" || true)"
        ipv6_response="$(curl --noproxy "*" -gfsS --max-time 1 \
          "http://[::1]:${IPV6_LOOPBACK_PROBE_PORT}" 2>>"$log_file" || true)"
        if [[ "$wildcard_response" == ready && "$ipv4_response" == ready && \
          "$ipv6_response" == ready ]]; then
          probe_ready=1
          break
        fi
      fi
      sleep 0.25
    done
    if (( probe_ready == 0 )); then
      echo "Could not establish the guest port-forwarding probe" >&2
      exit 1
    fi
  '; then
    echo "Guest port-forwarding probe setup failed; guest diagnostics follow" >&2
    colima -p "$profile" ssh -- bash -lc '
      pid_file=/tmp/openshapeforge-forwarding-probe.pid
      ready_file=/tmp/openshapeforge-forwarding-probe.ready
      log_file=/tmp/openshapeforge-forwarding-probe.log
      printf "node=%s ready_file=%s\n" \
        "$(command -v node 2>/dev/null || printf missing)" \
        "$([[ -f "$ready_file" ]] && printf present || printf missing)"
      if [[ -f "$pid_file" ]]; then
        pid="$(cat "$pid_file")"
        printf "pid=%s process=%s\n" "$pid" \
          "$(kill -0 "$pid" 2>/dev/null && printf alive || printf stopped)"
      else
        printf "pid=missing process=unknown\n"
      fi
      if [[ -s "$log_file" ]]; then
        printf "%s\n" "--- probe log ---"
        sed -n "1,80p" "$log_file"
      fi
      printf "%s\n" "--- guest TCP listeners ---"
      ss -ltnp 2>&1 | sed -n "1,80p" || true
      [[ -f "$pid_file" ]] && kill "$(cat "$pid_file")" >/dev/null 2>&1 || true
      rm -f "$pid_file" "$ready_file" "$log_file"
    ' >&2 || true
    return 1
  fi

  for attempt in {1..20}; do
    for port in "$wildcard_probe_port" "$ipv4_loopback_probe_port" "$ipv6_loopback_probe_port"; do
      if ! assert_host_tcp_port_unbound "$port"; then
        result=1
        break 2
      fi
      if nc -w 1 -z 127.0.0.1 "$port" >/dev/null 2>&1 ||
        nc -6 -w 1 -z ::1 "$port" >/dev/null 2>&1; then
        echo "Guest TCP port ${port} is reachable on the Mac" >&2
        result=1
        break 2
      fi
    done
    sleep 0.25
  done

  if ! colima -p "$profile" ssh -- env \
    WILDCARD_PROBE_PORT="$wildcard_probe_port" \
    IPV4_LOOPBACK_PROBE_PORT="$ipv4_loopback_probe_port" \
    IPV6_LOOPBACK_PROBE_PORT="$ipv6_loopback_probe_port" bash -lc '
    set -euo pipefail
    [[ "$(curl -fsS --max-time 1 "http://127.0.0.1:${WILDCARD_PROBE_PORT}")" == ready ]]
    [[ "$(curl -fsS --max-time 1 "http://127.0.0.1:${IPV4_LOOPBACK_PROBE_PORT}")" == ready ]]
    [[ "$(curl --noproxy "*" -gfsS --max-time 1 \
      "http://[::1]:${IPV6_LOOPBACK_PROBE_PORT}")" == ready ]]
  '; then
    echo "Guest port-forwarding probe stopped before host verification completed" >&2
    result=1
  fi

  if ! colima -p "$profile" ssh -- bash -lc '
    set -euo pipefail
    readonly pid_file=/tmp/openshapeforge-forwarding-probe.pid
    [[ -f "$pid_file" ]]
    pid="$(cat "$pid_file")"
    [[ "$pid" =~ ^[0-9]+$ ]]
    kill "$pid"
    for attempt in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    ! kill -0 "$pid" 2>/dev/null
    rm -f "$pid_file" /tmp/openshapeforge-forwarding-probe.ready \
      /tmp/openshapeforge-forwarding-probe.log
  '; then
    echo "Could not remove the guest port-forwarding probe" >&2
    result=1
  fi
  return "$result"
}

# macOS skips PF on lo0, including a usernet proxy connection back to this
# Mac. Prove that the guest OUTPUT chain blocks that path before any untrusted
# runner process exists; the runner later loses sudo and cannot alter the rule.
verify_guest_firewall_behavior() {
  local profile="$1"
  local default_interface target_ip listener result=0
  local usernet_port=49232
  default_interface="$(route -n get default | awk '/interface:/ { print $2; exit }')"
  target_ip="$(ipconfig getifaddr "$default_interface" 2>/dev/null || true)"
  nc -l "$target_ip" "$usernet_port" >/dev/null 2>&1 &
  listener=$!
  sleep 0.2
  if ! kill -0 "$listener" 2>/dev/null; then
    echo "Could not establish the guest firewall behavior listener" >&2
    wait "$listener" 2>/dev/null || true
    return 1
  fi

  set +e
  colima -p "$profile" ssh -- env TARGET_IP="$target_ip" \
    USERNET_PORT="$usernet_port" bash -lc '
      set -euo pipefail
      if timeout 2 bash -c "</dev/tcp/$TARGET_IP/$USERNET_PORT"; then
        echo "Guest firewall bypassed through the Colima user network" >&2
        exit 1
      fi
    '
  result=$?
  set -e

  kill "$listener" >/dev/null 2>&1 || true
  wait "$listener" 2>/dev/null || true
  return "$result"
}

# Rootless Docker uses a userspace network path. Exercise it separately so the
# runner cannot register unless containers are also unable to reach the Mac.
verify_rootless_docker_firewall_behavior() {
  local profile="$1"
  local default_interface target_ip listener result=0
  local rootless_port=49233
  default_interface="$(route -n get default | awk '/interface:/ { print $2; exit }')"
  target_ip="$(ipconfig getifaddr "$default_interface" 2>/dev/null || true)"
  nc -l "$target_ip" "$rootless_port" >/dev/null 2>&1 &
  listener=$!
  sleep 0.2
  if ! kill -0 "$listener" 2>/dev/null; then
    echo "Could not establish the rootless Docker behavior listener" >&2
    wait "$listener" 2>/dev/null || true
    return 1
  fi

  set +e
  colima -p "$profile" ssh -- env TARGET_IP="$target_ip" \
    ROOTLESS_PORT="$rootless_port" bash -lc '
      set -euo pipefail
      export XDG_RUNTIME_DIR="/run/user/$(id -u)"
      export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
      if docker run --rm -e TARGET_IP -e ROOTLESS_PORT alpine:3.20 sh -c \
        "nc -w 2 \"\$TARGET_IP\" \"\$ROOTLESS_PORT\""; then
        echo "Guest firewall bypassed through rootless Docker" >&2
        exit 1
      fi
      if docker run --rm --network host -e TARGET_IP -e ROOTLESS_PORT alpine:3.20 sh -c \
        "nc -w 2 \"\$TARGET_IP\" \"\$ROOTLESS_PORT\""; then
        echo "Guest firewall bypassed through rootless Docker host networking" >&2
        exit 1
      fi
      if docker run --rm --network=host -e TARGET_IP -e ROOTLESS_PORT alpine:3.20 sh -c \
        "nc -w 2 \"\$TARGET_IP\" \"\$ROOTLESS_PORT\""; then
        echo "Guest firewall bypassed through rootless Docker host networking (equals syntax)" >&2
        exit 1
      fi
    '
  result=$?
  set -e

  kill "$listener" >/dev/null 2>&1 || true
  wait "$listener" 2>/dev/null || true
  return "$result"
}

repository_runner_id() {
  local runner_name="$1"
  gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
    --jq ".runners[] | select(.name == \"${runner_name}\") | .id" \
    2>/dev/null
}

wait_for_repository_runner_id() {
  local runner_name="$1"
  local attempt runner_id
  for attempt in {1..15}; do
    runner_id="$(repository_runner_id "$runner_name" || true)"
    if [[ "$runner_id" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$runner_id"
      return 0
    fi
    sleep 2
  done
  echo "Could not verify registered runner id: ${runner_name}" >&2
  return 1
}

add_repository_runner_routing_label() {
  local runner_id="$1"
  if ! gh api --method POST "repos/${REPOSITORY}/actions/runners/${runner_id}/labels" \
    --field "labels[]=osf-pr" --silent; then
    echo "Could not add routing label to repository runner ${runner_id}" >&2
    return 1
  fi
  return 0
}

clear_repository_runner_labels() {
  local runner_id="$1"
  if ! gh api --method DELETE "repos/${REPOSITORY}/actions/runners/${runner_id}/labels" \
    --silent; then
    echo "Could not clear labels from repository runner ${runner_id}" >&2
    return 1
  fi
  return 0
}

repository_runner_state() {
  local runner_id="$1"
  local error_file="${SUPPORT_DIR}/runner-state-error.$$" state
  if state="$(gh api "repos/${REPOSITORY}/actions/runners/${runner_id}" \
    --jq '"\(.status):\(.busy)"' 2>"$error_file")"; then
    rm -f "$error_file"
    printf '%s\n' "$state"
    return 0
  fi
  if grep -Fq '(HTTP 404)' "$error_file"; then
    rm -f "$error_file"
    return 0
  fi
  cat "$error_file" >&2
  rm -f "$error_file"
  return 1
}

runner_service_active_state() {
  local profile="$1"
  local service="$2"
  colima -p "$profile" ssh -- env RUNNER_SERVICE="$service" bash -lc '
    set -euo pipefail
    systemctl show "$RUNNER_SERVICE" -p ActiveState --value
  '
}

wait_for_runner_online_or_consumed() {
  local profile="$1"
  local service="$2"
  local runner_id="$3"
  local runner_name="$4"
  local attempt runner_state service_state
  for attempt in {1..60}; do
    if ! runner_state="$(repository_runner_state "$runner_id")"; then
      sleep 2
      continue
    fi
    if [[ "$runner_state" == online:* ]]; then
      printf 'online\n'
      return 0
    fi
    service_state="$(runner_service_active_state "$profile" "$service" || true)"
    if [[ -z "$runner_state" && "$service_state" == inactive ]]; then
      printf 'consumed\n'
      return 0
    fi
    sleep 2
  done
  echo "Runner neither became online nor completed successfully: ${runner_name}" >&2
  return 1
}

wait_for_ephemeral_runner_completion() {
  local runner_id="$1"
  local runner_name="$2"
  local state offline_checks=0
  while true; do
    if ! state="$(repository_runner_state "$runner_id")"; then
      sleep 3
      continue
    fi
    [[ -z "$state" ]] && return 0
    if [[ "$state" == offline:* ]]; then
      ((offline_checks += 1))
      if (( offline_checks >= 20 )); then
        echo "Runner stayed offline after registration: ${runner_name}" >&2
        return 1
      fi
    else
      offline_checks=0
    fi
    sleep 3
  done
}

acquire_provision_lock() {
  until shlock -f "$PROVISION_LOCK" -p "$$"; do
    sleep 2
  done
}

release_provision_lock() {
  local owner
  owner="$(cat "$PROVISION_LOCK" 2>/dev/null || true)"
  if [[ "$owner" == "$$" ]]; then
    unlink "$PROVISION_LOCK"
  fi
  return 0
}

provision_slot_locked() {
  local slot="$1"
  local profile runner_name bootstrap_label runner_id machine_id service lifecycle_state
  local approved_workflow_shas
  profile="$(profile_for "$slot")"
  runner_name="$(runner_prefix_for "$slot")-$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c 1-8)"
  bootstrap_label="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  [[ "$bootstrap_label" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
    echo "Could not generate a full UUID bootstrap label" >&2
    return 1
  }

  require_host_isolation
  cleanup_slot "$slot" || return 1
  # Keep the guest and runner toolchain native ARM64. Rosetta provides the fast
  # amd64 path; binfmt retains Colima's supported fallback when needed.
  start_colima_profile "$profile" || return 1
  harden_colima_loopback_forwarding "$profile"

  verify_host_network_boundary "$profile"

  colima -p "$profile" ssh -- env PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" \
    RUNNER_USER="$RUNNER_USER" \
    NODE_VERSION="$NODE_VERSION" NODE_SHA256="$NODE_SHA256" \
    MAVEN_VERSION="$MAVEN_VERSION" MAVEN_SHA512="$MAVEN_SHA512" bash -lc '
    set -euo pipefail
    sudo apt-get update >/dev/null
    sudo apt-get install -y curl git wget unzip zstd jq iptables xz-utils >/dev/null
    node_archive="/tmp/node-v${NODE_VERSION}-linux-arm64.tar.xz"
    curl -fsSLo "$node_archive" \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"
    printf "%s  %s\n" "$NODE_SHA256" "$node_archive" | sha256sum -c - >/dev/null
    sudo install -d -o root -g root -m 0755 /opt/node
    sudo tar xJf "$node_archive" -C /opt/node --strip-components=1
    for executable in node npm npx corepack; do
      sudo ln -sfn "/opt/node/bin/${executable}" "/usr/local/bin/${executable}"
    done
    rm -f "$node_archive"
    maven_archive="/tmp/apache-maven-${MAVEN_VERSION}-bin.tar.gz"
    curl -fsSLo "$maven_archive" \
      "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${MAVEN_VERSION}/apache-maven-${MAVEN_VERSION}-bin.tar.gz"
    printf "%s  %s\n" "$MAVEN_SHA512" "$maven_archive" | sha512sum -c - >/dev/null
    sudo tar xzf "$maven_archive" -C /opt
    sudo ln -sfn "/opt/apache-maven-${MAVEN_VERSION}/bin/mvn" /usr/local/bin/mvn
    rm -f "$maven_archive"
    sudo env PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" \
      npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium >/dev/null
    sudo install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0700 /opt/actions-runner
  '
  cat "$RUNNER_ARCHIVE" | colima -p "$profile" ssh -- env RUNNER_USER="$RUNNER_USER" bash -lc \
    'sudo tar xzf - -C /opt/actions-runner && sudo chown -R "$RUNNER_USER:$RUNNER_USER" /opt/actions-runner'
  colima -p "$profile" ssh -- bash -lc \
    'cd /opt/actions-runner && sudo ./bin/installdependencies.sh >/dev/null'
  isolate_runner_network "$profile"
  verify_guest_firewall_behavior "$profile"
  setup_rootless_docker "$profile"
  verify_fresh_vm "$profile"
  verify_rootless_docker_firewall_behavior "$profile"
  verify_cross_architecture_container_execution "$profile"
  verify_guest_port_forwarding_disabled "$profile"

  require_host_isolation
  verify_host_network_boundary "$profile"
  gh api --method POST "repos/${REPOSITORY}/actions/runners/registration-token" --jq .token |
    colima -p "$profile" ssh -- env RUNNER_NAME="$runner_name" \
      RUNNER_BOOTSTRAP_LABEL="$bootstrap_label" bash -lc '
      set -euo pipefail
      read -r runner_token
      cd /opt/actions-runner
      # The pinned runner requires one custom label when default labels are disabled.
      # The controller clears it before the service is installed or started.
      ./config.sh --unattended --ephemeral --disableupdate \
        --url https://github.com/OpenShapeForge/OpenShapeForge \
        --token "$runner_token" --name "$RUNNER_NAME" \
        --labels "$RUNNER_BOOTSTRAP_LABEL" --no-default-labels --work _work
      unset runner_token RUNNER_BOOTSTRAP_LABEL
    '
  runner_id="$(wait_for_repository_runner_id "$runner_name")"
  clear_repository_runner_labels "$runner_id"

  service="$(runner_service_for "$runner_name")"
  install_runner_service "$profile" "$service"
  harden_runner_before_start "$profile" "$service"
  verify_unprivileged_runner "$profile" "$service"

  machine_id="$(colima -p "$profile" ssh -- cat /etc/machine-id)"
  # The listener is still absent and the runner has no routing labels. Take the
  # immutable workflow snapshot as late as possible before admission.
  approved_workflow_shas="$(authorize_active_workflow_shas)" || return 1
  install_pre_job_policy "$profile" "$approved_workflow_shas"
  verify_pre_job_policy "$profile" "$service"
  add_repository_runner_routing_label "$runner_id"
  start_runner_service "$profile" "$service"
  lifecycle_state="$(wait_for_runner_online_or_consumed \
    "$profile" "$service" "$runner_id" "$runner_name")"
  if [[ "$lifecycle_state" == online ]]; then
    echo "READY slot=${slot} runner=${runner_name} machine_id=${machine_id}"
    printf '%s\n' "$runner_name" >"${SUPPORT_DIR}/slot-${slot}.runner"
    printf '%s\n' "$machine_id" >"${SUPPORT_DIR}/slot-${slot}.machine-id"
    release_provision_lock
    wait_for_ephemeral_runner_completion "$runner_id" "$runner_name" || return 1
  else
    release_provision_lock
  fi
  echo "COMPLETE slot=${slot} runner=${runner_name} machine_id=${machine_id}"
}

provision_slot() (
  local slot="$1"
  local result
  acquire_provision_lock
  trap release_provision_lock EXIT
  set +e
  (set -e; provision_slot_locked "$slot")
  result=$?
  release_provision_lock
  trap - EXIT
  return "$result"
)

cleanup_slot_serialized() (
  local slot="$1"
  local result
  acquire_provision_lock
  trap release_provision_lock EXIT
  set +e
  (set -e; cleanup_slot "$slot")
  result=$?
  release_provision_lock
  trap - EXIT
  return "$result"
)

cleanup_slot_on_exit() {
  local slot="$1"
  release_provision_lock
  cleanup_slot_serialized "$slot"
}

SUPERVISOR_PROVISION_PID=""
SUPERVISOR_PROVISION_PROTOCOL_DIR=""
SUPERVISOR_PROVISION_READY_FILE=""
SUPERVISOR_PROVISION_RESULT_FILE=""
SUPERVISOR_ACTIVE_PROBE_DIR=""
SUPERVISOR_PROBE_CANCEL_FILE=""
SUPERVISOR_PROBE_REAPED_FILE=""
SUPERVISOR_PROVISION_STATE="idle"
SUPERVISOR_PENDING_SIGNAL_STATUS=""

provision_pid_is_direct_child() {
  local provision_pid="$1"
  local parent_pid
  [[ "$provision_pid" =~ ^[0-9]+$ ]] || return 1
  parent_pid="$(ps -p "$provision_pid" -o ppid= 2>/dev/null)" || return 1
  parent_pid="${parent_pid//[[:space:]]/}"
  [[ "$parent_pid" == "$$" ]]
}

provision_anchor_is_direct_child() {
  local provision_pid="$1"
  local process_group_id
  provision_pid_is_direct_child "$provision_pid" || return 1
  process_group_id="$(ps -p "$provision_pid" -o pgid= 2>/dev/null)" || return 1
  process_group_id="${process_group_id//[[:space:]]/}"
  [[ "$process_group_id" == "$provision_pid" ]]
}

provision_anchor_is_active() {
  local provision_pid="$1"
  local state
  provision_anchor_is_direct_child "$provision_pid" || return 1
  state="$(ps -p "$provision_pid" -o stat= 2>/dev/null)" || return 1
  state="${state//[[:space:]]/}"
  [[ -n "$state" && "$state" != Z* ]]
}

provision_group_has_live_processes() {
  local provision_pid="$1"
  local processes scan_result
  processes="$(ps -axo pgid=,stat= 2>/dev/null)" || return 2
  printf '%s\n' "$processes" | awk -v group="$provision_pid" '
    $1 == group && $2 !~ /^Z/ { found = 1 }
    END { exit(found ? 0 : 1) }
  '
  scan_result=$?
  return "$scan_result"
}

wait_for_provision_group_death() {
  local provision_pid="$1"
  local attempt group_state
  for attempt in {1..20}; do
    if provision_group_has_live_processes "$provision_pid"; then
      group_state=0
    else
      group_state=$?
    fi
    (( group_state == 1 )) && return 0
    (( group_state == 2 )) && return 1
    /bin/sleep 0.05
  done
  return 1
}

reap_dead_provision_anchor() {
  local provision_pid="$1"
  local expected_status="$2"
  local wait_status
  wait_for_provision_group_death "$provision_pid" || return 1
  if builtin wait "$provision_pid" 2>/dev/null; then
    wait_status=0
  else
    wait_status=$?
  fi
  (( wait_status == expected_status ))
}

force_kill_and_reap_provision_anchor() {
  local provision_pid="$1"
  provision_anchor_is_direct_child "$provision_pid" || return 1
  kill -KILL -- "-${provision_pid}" >/dev/null 2>&1 || return 1
  reap_dead_provision_anchor "$provision_pid" 137
}

clear_active_provision_identity() {
  if [[ -n "$SUPERVISOR_PROVISION_READY_FILE" ]]; then
    unlink "$SUPERVISOR_PROVISION_READY_FILE" >/dev/null 2>&1 || true
    SUPERVISOR_PROVISION_READY_FILE=""
  fi
  if [[ -n "$SUPERVISOR_PROVISION_RESULT_FILE" ]]; then
    unlink "$SUPERVISOR_PROVISION_RESULT_FILE" >/dev/null 2>&1 || true
    SUPERVISOR_PROVISION_RESULT_FILE=""
  fi
  if [[ -n "$SUPERVISOR_PROBE_CANCEL_FILE" ]]; then
    unlink "$SUPERVISOR_PROBE_CANCEL_FILE" >/dev/null 2>&1 || true
    SUPERVISOR_PROBE_CANCEL_FILE=""
  fi
  if [[ -n "$SUPERVISOR_PROBE_REAPED_FILE" ]]; then
    unlink "$SUPERVISOR_PROBE_REAPED_FILE" >/dev/null 2>&1 || true
    SUPERVISOR_PROBE_REAPED_FILE=""
  fi
  if [[ -n "$SUPERVISOR_ACTIVE_PROBE_DIR" ]]; then
    if [[ -d "$SUPERVISOR_ACTIVE_PROBE_DIR" ]] &&
      ! rmdir "$SUPERVISOR_ACTIVE_PROBE_DIR" >/dev/null 2>&1; then
      echo "Could not remove retained active readiness probe marker" >&2
    fi
    SUPERVISOR_ACTIVE_PROBE_DIR=""
  fi
  if [[ -n "$SUPERVISOR_PROVISION_PROTOCOL_DIR" ]]; then
    if [[ -d "$SUPERVISOR_PROVISION_PROTOCOL_DIR" ]] &&
      ! rmdir "$SUPERVISOR_PROVISION_PROTOCOL_DIR" >/dev/null 2>&1; then
      echo "Could not remove retained supervisor protocol directory" >&2
    fi
    SUPERVISOR_PROVISION_PROTOCOL_DIR=""
  fi
}

clear_reaped_active_provision_identity() {
  SUPERVISOR_PROVISION_PID=""
  SUPERVISOR_PROVISION_STATE="idle"
  clear_active_provision_identity
}

request_active_probe_cancellation() {
  local cancel_file="${SUPERVISOR_PROBE_CANCEL_FILE:-}"
  local cancel_temp_file
  [[ -n "$cancel_file" ]] || return 0
  cancel_temp_file="${cancel_file}.tmp"
  printf 'cancel\n' >"$cancel_temp_file" && mv "$cancel_temp_file" "$cancel_file"
}

terminate_active_provision() {
  local provision_pid="${SUPERVISOR_PROVISION_PID:-}"
  local anchor_wait_status=0 attempt attempt_limit termination_result=0
  if [[ ! "$provision_pid" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  attempt_limit="$(provision_termination_grace_attempt_limit)" || return 1
  [[ "$attempt_limit" =~ ^[1-9][0-9]*$ ]] || return 1
  SUPERVISOR_PROVISION_STATE="terminating"

  if ! provision_anchor_is_direct_child "$provision_pid"; then
    echo "Could not validate active provisioning anchor pid ${provision_pid}" >&2
    return 1
  fi
  if ! request_active_probe_cancellation; then
    echo "Could not publish active readiness probe cancellation" >&2
    return 1
  fi
  # The readiness wrapper creates this directory before it may spawn its own
  # process group and removes it only after that group is reaped. Publishing the
  # cancellation request first closes the launch race: a later wrapper observes
  # the request before spawning, while an active wrapper clears the directory.
  if [[ -n "${SUPERVISOR_ACTIVE_PROBE_DIR:-}" &&
    -d "$SUPERVISOR_ACTIVE_PROBE_DIR" ]]; then
    for ((attempt = 1; attempt <= attempt_limit; attempt += 1)); do
      if [[ ! -d "$SUPERVISOR_ACTIVE_PROBE_DIR" ]] ||
        [[ -n "${SUPERVISOR_PROBE_REAPED_FILE:-}" &&
          -s "$SUPERVISOR_PROBE_REAPED_FILE" ]]; then
        break
      fi
      if ! provision_anchor_is_direct_child "$provision_pid"; then
        echo "Provisioning anchor pid ${provision_pid} lost its stable identity during probe cleanup" >&2
        return 1
      fi
      /bin/sleep 0.05
    done
    if [[ -d "$SUPERVISOR_ACTIVE_PROBE_DIR" ]]; then
      if [[ -n "${SUPERVISOR_PROBE_REAPED_FILE:-}" &&
        -s "$SUPERVISOR_PROBE_REAPED_FILE" ]]; then
        echo "Proceeding after probe reaped proof with a retained marker" >&2
      else
        echo "Active readiness probe missed its cancellation deadline" >&2
        return 1
      fi
    fi
  fi
  if ! kill -TERM -- "-${provision_pid}" >/dev/null 2>&1; then
    termination_result=1
  fi
  /bin/sleep 0.5
  if ! provision_anchor_is_direct_child "$provision_pid"; then
    echo "Provisioning anchor pid ${provision_pid} lost its stable identity before KILL" >&2
    return 1
  fi
  if provision_anchor_is_active "$provision_pid" ||
    provision_group_has_live_processes "$provision_pid"; then
    echo \
      "Provisioning processes for pid ${provision_pid} reached the TERM deadline; forcing termination" \
      >&2
    if ! kill -KILL -- "-${provision_pid}" >/dev/null 2>&1; then
      echo "Could not force termination of provisioning group ${provision_pid}" >&2
      return 1
    fi
    anchor_wait_status=137
  fi
  if ! reap_dead_provision_anchor "$provision_pid" "$anchor_wait_status"; then
    echo "Could not confirm provisioning group ${provision_pid} died and was reaped" >&2
    return 1
  fi
  clear_reaped_active_provision_identity
  return "$termination_result"
}

run_active_provision_anchor() {
  local slot="$1"
  local ready_file="$2"
  local result_file="$3"
  local provision_result provision_worker_pid
  trap - EXIT
  trap '' INT TERM
  trap 'exit 0' USR1
  set +e
  (
    trap - INT TERM
    provision_slot "$slot"
  ) &
  provision_worker_pid=$!
  printf 'ready\n' >"$ready_file"
  builtin wait "$provision_worker_pid"
  provision_result=$?
  printf '%s\n' "$provision_result" >"$result_file"
  while true; do :; done
}

launch_active_provision() {
  local slot="$1"
  local active_probe_dir cancel_file protocol_dir ready_file reaped_file result_file
  local launch_attempt pending_signal_status provision_pid
  if ! protocol_dir="$(
    mktemp -d "${SUPPORT_DIR}/.supervisor-provision.XXXXXX"
  )"; then
    echo "Could not allocate fresh supervisor protocol state" >&2
    return 1
  fi
  ready_file="${protocol_dir}/ready"
  result_file="${protocol_dir}/result"
  active_probe_dir="${protocol_dir}/active-probe"
  cancel_file="${protocol_dir}/cancel"
  reaped_file="${protocol_dir}/probe-reaped"
  SUPERVISOR_PROVISION_PROTOCOL_DIR="$protocol_dir"
  SUPERVISOR_PROVISION_READY_FILE="$ready_file"
  SUPERVISOR_PROVISION_RESULT_FILE="$result_file"
  SUPERVISOR_ACTIVE_PROBE_DIR="$active_probe_dir"
  SUPERVISOR_PROBE_CANCEL_FILE="$cancel_file"
  SUPERVISOR_PROBE_REAPED_FILE="$reaped_file"
  SUPERVISOR_PENDING_SIGNAL_STATUS=""
  SUPERVISOR_PROVISION_PID=""
  SUPERVISOR_PROVISION_STATE="launching"

  set -m
  (set +m; run_active_provision_anchor "$slot" "$ready_file" "$result_file") &
  provision_pid=$!
  set +m

  for launch_attempt in {1..300}; do
    [[ -s "$ready_file" ]] && break
    kill -0 "$provision_pid" >/dev/null 2>&1 || break
    /bin/sleep 0.01
  done
  if [[ ! -s "$ready_file" ]] || ! provision_anchor_is_active "$provision_pid"; then
    pending_signal_status="$SUPERVISOR_PENDING_SIGNAL_STATUS"
    # Retain the local anchor identity for EXIT retry until group death and
    # reaping are confirmed, even though active publication failed.
    SUPERVISOR_PROVISION_PID="$provision_pid"
    SUPERVISOR_PROVISION_STATE="failed"
    if force_kill_and_reap_provision_anchor "$provision_pid"; then
      clear_reaped_active_provision_identity
    else
      echo "Could not discard unpublished provisioning anchor pid ${provision_pid}" >&2
    fi
    if [[ -n "$pending_signal_status" ]]; then
      supervisor_signal_exit "$pending_signal_status"
    fi
    echo "Provisioning anchor failed before publishing a stable identity" >&2
    return 1
  fi
  SUPERVISOR_PROVISION_PID="$provision_pid"
  SUPERVISOR_PROVISION_STATE="active"
  if [[ -n "$SUPERVISOR_PENDING_SIGNAL_STATUS" ]]; then
    supervisor_signal_exit "$SUPERVISOR_PENDING_SIGNAL_STATUS"
  fi
}

release_and_reap_provision_anchor() {
  local provision_pid="$1"
  local attempt
  provision_anchor_is_active "$provision_pid" || return 1
  kill -USR1 -- "$provision_pid" >/dev/null 2>&1 || return 1
  for attempt in {1..20}; do
    if ! provision_anchor_is_active "$provision_pid"; then
      reap_dead_provision_anchor "$provision_pid" 0 && return 0
      return 1
    fi
    /bin/sleep 0.05
  done
  return 1
}

wait_for_active_provision_result() {
  local provision_pid="${SUPERVISOR_PROVISION_PID:-}"
  local provision_result result_file="${SUPERVISOR_PROVISION_RESULT_FILE:-}"
  local pending_signal_status
  while [[ -n "$result_file" && ! -s "$result_file" ]]; do
    if ! provision_anchor_is_active "$provision_pid"; then
      echo "Provisioning anchor pid ${provision_pid} exited before reporting a result" >&2
      if force_kill_and_reap_provision_anchor "$provision_pid"; then
        clear_reaped_active_provision_identity
      fi
      return 1
    fi
    /bin/sleep 0.05
  done
  if [[ -z "$result_file" ]] || ! read -r provision_result <"$result_file" ||
    [[ ! "$provision_result" =~ ^[0-9]+$ ]] || (( provision_result > 255 )); then
    echo "Provisioning anchor pid ${provision_pid} reported an invalid result" >&2
    if force_kill_and_reap_provision_anchor "$provision_pid"; then
      clear_reaped_active_provision_identity
    fi
    return 1
  fi
  if ! provision_anchor_is_active "$provision_pid"; then
    echo "Provisioning anchor pid ${provision_pid} exited before release" >&2
    if force_kill_and_reap_provision_anchor "$provision_pid"; then
      clear_reaped_active_provision_identity
    fi
    return 1
  fi

  SUPERVISOR_PROVISION_STATE="releasing"
  if release_and_reap_provision_anchor "$provision_pid"; then
    clear_reaped_active_provision_identity
  else
    echo "Provisioning anchor pid ${provision_pid} missed its release deadline; terminating group" >&2
    provision_result=1
    if ! terminate_active_provision; then
      return 1
    fi
  fi
  pending_signal_status="$SUPERVISOR_PENDING_SIGNAL_STATUS"
  if [[ -n "$pending_signal_status" ]]; then
    supervisor_signal_exit "$pending_signal_status"
  fi
  return "$provision_result"
}

supervisor_signal_received() {
  local exit_status="$1"
  if [[ "$SUPERVISOR_PROVISION_STATE" == "launching" ||
    "$SUPERVISOR_PROVISION_STATE" == "releasing" ]]; then
    if [[ -z "$SUPERVISOR_PENDING_SIGNAL_STATUS" ]]; then
      SUPERVISOR_PENDING_SIGNAL_STATUS="$exit_status"
    fi
    return 0
  fi
  supervisor_signal_exit "$exit_status"
}

supervisor_signal_exit() {
  local exit_status="$1"
  local termination_result=0
  trap '' INT TERM
  if terminate_active_provision; then
    termination_result=0
  else
    termination_result=$?
    echo "Active provisioning termination failed with status ${termination_result}" >&2
  fi
  exit "$exit_status"
}

supervisor_exit_cleanup() {
  local exit_status="$1"
  local slot="$2"
  local cleanup_result=0 termination_result=0
  trap - EXIT
  if [[ "${SUPERVISOR_PROVISION_PID:-}" =~ ^[0-9]+$ ]]; then
    if terminate_active_provision; then
      termination_result=0
    else
      termination_result=$?
      echo "Supervisor exit could not terminate provisioning with status ${termination_result}" >&2
    fi
  fi
  if (( termination_result == 0 )); then
    if cleanup_slot_on_exit "$slot"; then
      cleanup_result=0
    else
      cleanup_result=$?
      echo "Supervisor cleanup for slot ${slot} failed with status ${cleanup_result}" >&2
    fi
  else
    cleanup_result="$termination_result"
  fi
  if (( exit_status != 0 )); then
    exit "$exit_status"
  fi
  exit "$cleanup_result"
}

install_supervisor_exit_traps() {
  local slot="${1:-}"
  local configured_slot exit_trap
  for configured_slot in "${SLOTS[@]}"; do
    [[ "$slot" == "$configured_slot" ]] || continue
    # Bash 3.2 may run EXIT after this function's locals leave scope.
    printf -v exit_trap 'supervisor_exit_cleanup "$?" %q' "$slot"
    trap "$exit_trap" EXIT
    trap 'supervisor_signal_received 130' INT
    trap 'supervisor_signal_received 143' TERM
    return 0
  done
  echo "Refusing to supervise unconfigured slot: ${slot:-<missing>}" >&2
  return 2
}

supervise_slot() {
  local slot="$1"
  local provision_result cleanup_result
  install_supervisor_exit_traps "$slot"
  require_host_tools
  require_host_isolation
  ensure_runner_archive
  while true; do
    launch_active_provision "$slot"
    set +e
    wait_for_active_provision_result
    provision_result=$?
    set -e
    if [[ "${SUPERVISOR_PROVISION_PID:-}" =~ ^[0-9]+$ ]]; then
      echo "Provisioning identity remains active after failed cleanup; exiting for final retry" >&2
      return 1
    fi
    if (( provision_result != 0 )); then
      echo "Slot ${slot} provisioning failed; retrying in 10 seconds" >&2
    fi
    while true; do
      set +e
      cleanup_slot_serialized "$slot"
      cleanup_result=$?
      set -e
      (( cleanup_result == 0 )) && break
      echo "Slot ${slot} cleanup refused or failed; retrying in 10 seconds" >&2
      sleep 10
    done
    (( provision_result != 0 )) && sleep 10
  done
}

write_launch_agent() {
  local slot="$1"
  local label plist escaped_label escaped_launcher escaped_log_dir
  local escaped_isolation_group escaped_runner_prefix escaped_deploy_prefix
  require_runner_identity_values || return 1
  label="$(agent_label_for "$slot")"
  plist="$(plist_for "$slot")"
  escaped_label="$(xml_escape "$label")"
  escaped_launcher="$(xml_escape "$HOST_LAUNCHER")"
  escaped_log_dir="$(xml_escape "$LOG_DIR")"
  escaped_isolation_group="$(xml_escape "$ISOLATION_GROUP")"
  escaped_runner_prefix="$(xml_escape "$RUNNER_NAME_PREFIX")"
  escaped_deploy_prefix="$(xml_escape "$DISABLED_DEPLOY_RUNNER_PREFIX")"
  mkdir -p "$(dirname "$plist")" "$LOG_DIR"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escaped_label}</string>
  <key>ProgramArguments</key><array>
    <string>${escaped_launcher}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escaped_log_dir}/slot-${slot}.log</string>
  <key>StandardErrorPath</key><string>${escaped_log_dir}/slot-${slot}.error.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP</key><string>${escaped_isolation_group}</string>
    <key>OPENSHAPEFORGE_RUNNER_NAME_PREFIX</key><string>${escaped_runner_prefix}</string>
    <key>OPENSHAPEFORGE_DEPLOY_RUNNER_PREFIX</key><string>${escaped_deploy_prefix}</string>
  </dict>
</dict></plist>
EOF
  plutil -lint "$plist" >/dev/null
}

start_supervisors() {
  require_host_isolation
  mkdir -p "$SUPPORT_DIR" "$LOG_DIR"
  install -m 0700 "$0" "$INSTALLED_SCRIPT"
  ensure_runner_archive
  disable_local_deploy_runner

  local slot plist
  for slot in "${SLOTS[@]}"; do
    write_launch_agent "$slot"
    plist="$(plist_for "$slot")"
    launchctl bootout "gui/${UID}" "$plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/${UID}" "$plist"
    echo "slot ${slot}: supervisor started"
  done
}

wait_for_supervisor_exit() {
  local slot="$1"
  local attempt
  for attempt in {1..50}; do
    if ! pgrep -f "${INSTALLED_SCRIPT} supervise-slot ${slot}" >/dev/null; then
      return
    fi
    sleep 0.2
  done
  echo "Supervisor did not stop cleanly: slot ${slot}" >&2
  return 1
}

preflight_stop() {
  local slot prefix busy
  for slot in "${SLOTS[@]}"; do
    prefix="$(runner_prefix_for "$slot")"
    if ! busy="$(
      gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
        --jq ".runners[] | select(.name | startswith(\"${prefix}\")) | select(.busy == true) | .name"
    )"; then
      echo "Could not verify runner state for slot ${slot}; supervisors remain active" >&2
      return 1
    fi
    if [[ -n "$busy" ]]; then
      echo "Refusing to stop busy runner slot ${slot}: ${busy}" >&2
      return 1
    fi
  done
}

restore_supervisors() {
  local slot plist
  for slot in "${SLOTS[@]}"; do
    plist="$(plist_for "$slot")"
    if ! launchctl print "gui/${UID}/$(agent_label_for "$slot")" >/dev/null 2>&1; then
      launchctl bootstrap "gui/${UID}" "$plist"
    fi
  done
}

stop_supervisors() {
  local slot plist result wait_result=0
  preflight_stop
  for slot in "${SLOTS[@]}"; do
    plist="$(plist_for "$slot")"
    launchctl bootout "gui/${UID}" "$plist" >/dev/null 2>&1 || true
  done
  for slot in "${SLOTS[@]}"; do
    if ! wait_for_supervisor_exit "$slot"; then
      wait_result=1
    fi
  done
  if (( wait_result != 0 )); then
    echo "A supervisor did not stop cleanly; restoring all configured supervisors" >&2
    restore_supervisors || true
    return 1
  fi

  acquire_provision_lock
  set +e
  (
    set -e
    for slot in "${SLOTS[@]}"; do
      cleanup_slot "$slot"
      echo "slot ${slot}: stopped and deleted"
    done
    disable_local_deploy_runner
  )
  result=$?
  set -e
  release_provision_lock
  if (( result != 0 )); then
    echo "Cleanup failed; restoring supervisors so runner state remains managed" >&2
    restore_supervisors || true
  fi
  return "$result"
}

show_status() {
  local slot label
  for slot in "${SLOTS[@]}"; do
    label="$(agent_label_for "$slot")"
    if launchctl print "gui/${UID}/${label}" >/dev/null 2>&1; then
      echo "slot ${slot}: supervisor running"
    else
      echo "slot ${slot}: supervisor stopped"
    fi
  done
  gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
    --jq ".runners[] | select(.name | startswith(\"${RUNNER_NAME_PREFIX}\")) |
      \"\(.name): \(.status), busy=\(.busy), labels=\([.labels[].name] | join(\",\"))\""
}

verify_slots() {
  local slot profile runner_name service repository_runner_names
  for slot in "${SLOTS[@]}"; do
    profile="$(profile_for "$slot")"
    runner_name="$(cat "${SUPPORT_DIR}/slot-${slot}.runner")"
    service="$(runner_service_for "$runner_name")"
    require_host_isolation
    verify_host_network_boundary "$profile"
    verify_guest_firewall_behavior "$profile"
    verify_fresh_vm "$profile"
    verify_rootless_docker_firewall_behavior "$profile"
    verify_cross_architecture_container_execution "$profile"
    verify_pre_job_policy "$profile" "$service"
    verify_unprivileged_runner "$profile" "$service"
    colima -p "$profile" ssh -- bash -lc 'printf "machine_id=%s\\n" "$(cat /etc/machine-id)"'
  done
  if ! repository_runner_names="$(
    gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
      --jq '.runners[].name'
  )"; then
    echo "Could not verify the repository runner inventory" >&2
    return 1
  fi
  if grep -Fxq "$DISABLED_DEPLOY_RUNNER_PREFIX" <<<"$repository_runner_names"; then
    echo "Local deploy runner must remain unregistered" >&2
    return 1
  fi
}

main() {
  require_host_tools
  require_runner_identity_values

  case "$COMMAND" in
    start) start_supervisors ;;
    stop) stop_supervisors ;;
    status) show_status ;;
    verify) verify_slots ;;
    supervise-slot)
      [[ "${2:-}" == "1" ]] || {
        echo "supervise-slot requires slot 1" >&2
        exit 2
      }
      supervise_slot "$2"
      ;;
    *)
      echo "Usage: $0 {start|stop|status|verify}" >&2
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
