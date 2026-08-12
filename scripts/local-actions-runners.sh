#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1

# Versioned source for the macOS runner supervisor. `start` installs a private
# host copy so pull-request checkouts never control the running process.

set -euo pipefail

readonly REPOSITORY="OpenShapeForge/OpenShapeForge"
readonly COMMAND="${1:-status}"
readonly SLOT_CPUS=6
readonly SLOT_MEMORY_GIB=14
readonly RUNNER_VERSION="2.336.0"
readonly RUNNER_SHA256="58b758e420b87093fbd4bfddd368074960053e2f1388f01848c82624b90f27d1"
readonly PLAYWRIGHT_VERSION="1.62.1"
readonly NODE_VERSION="22.23.2"
readonly NODE_SHA256="fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8"
readonly MAVEN_VERSION="3.9.16"
readonly MAVEN_SHA512="831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6"
readonly SUPPORT_DIR="${HOME}/Library/Application Support/OpenShapeForge Actions"
readonly LOG_DIR="${HOME}/Library/Logs/OpenShapeForgeActions"
readonly CAPACITY_CONFIG="${SUPPORT_DIR}/runner-capacity"
readonly INSTALLED_SCRIPT="${SUPPORT_DIR}/local-actions-runners.sh"
readonly RUNNER_ARCHIVE="${SUPPORT_DIR}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz"
readonly PROVISION_LOCK="${SUPPORT_DIR}/provision.lock"
readonly HOST_LAUNCHER="/usr/local/libexec/openshapeforge-actions-launcher"
readonly HOST_FIREWALL_PLIST="/Library/LaunchDaemons/com.openshapeforge.actions.firewall.plist"
readonly HOST_FIREWALL_RULES="/Library/Application Support/OpenShapeForge Actions/pf-anchor.conf"
readonly ISOLATION_GROUP="${OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP:-_osfci}"
readonly RUNNER_USER="$(id -un)"
readonly RUNNER_NAME_PREFIX="${OPENSHAPEFORGE_RUNNER_NAME_PREFIX:-openshapeforge-pr}"
readonly DISABLED_DEPLOY_RUNNER_PREFIX="${OPENSHAPEFORGE_DEPLOY_RUNNER_PREFIX:-openshapeforge-deploy}"
SLOT_COUNT="${OPENSHAPEFORGE_RUNNER_SLOT_COUNT:-}"
HOST_CPU_LIMIT="${OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT:-}"
HOST_MEMORY_GIB_LIMIT="${OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT:-}"
PERSISTED_SLOT_COUNT=""
PERSISTED_HOST_CPU_LIMIT=""
PERSISTED_HOST_MEMORY_GIB_LIMIT=""
SLOTS=()

require_host_tools() {
  local tool
  for tool in colima curl dscl gh ifconfig ipconfig jq launchctl limactl lsof nc ps route shasum shlock stat unlink uuidgen; do
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

require_positive_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ || ${#value} -gt 9 ]]; then
    echo "${name} must be a positive integer" >&2
    return 1
  fi
}

read_persisted_capacity_configuration() {
  local persisted_slot_count persisted_cpu_limit persisted_memory_limit extra read_status=0
  if [[ ! -e "$CAPACITY_CONFIG" ]]; then
    return 0
  fi
  if [[ ! -r "$CAPACITY_CONFIG" ]]; then
    echo "Runner capacity configuration is not readable" >&2
    return 1
  fi
  {
    IFS= read -r persisted_slot_count || read_status=1
    IFS= read -r persisted_cpu_limit || read_status=1
    IFS= read -r persisted_memory_limit || read_status=1
    if IFS= read -r extra; then
      read_status=2
    fi
  } <"$CAPACITY_CONFIG"
  if (( read_status == 1 )); then
    echo "Runner capacity configuration is incomplete" >&2
    return 1
  fi
  if (( read_status == 2 )); then
    echo "Runner capacity configuration has unexpected data" >&2
    return 1
  fi
  PERSISTED_SLOT_COUNT="$persisted_slot_count"
  PERSISTED_HOST_CPU_LIMIT="$persisted_cpu_limit"
  PERSISTED_HOST_MEMORY_GIB_LIMIT="$persisted_memory_limit"
  require_positive_integer "persisted runner slot count" "$PERSISTED_SLOT_COUNT"
  require_positive_integer "persisted runner CPU limit" "$PERSISTED_HOST_CPU_LIMIT"
  require_positive_integer "persisted runner memory limit" "$PERSISTED_HOST_MEMORY_GIB_LIMIT"
}

load_capacity_configuration() {
  local explicit_value_count=0
  [[ -n "$SLOT_COUNT" ]] && ((explicit_value_count += 1))
  [[ -n "$HOST_CPU_LIMIT" ]] && ((explicit_value_count += 1))
  [[ -n "$HOST_MEMORY_GIB_LIMIT" ]] && ((explicit_value_count += 1))
  if (( explicit_value_count != 0 && explicit_value_count != 3 )); then
    echo "Runner capacity overrides must set slot count, CPU limit and memory limit together" >&2
    return 1
  fi

  read_persisted_capacity_configuration
  if (( explicit_value_count == 0 )) && [[ -n "$PERSISTED_SLOT_COUNT" ]]; then
    SLOT_COUNT="$PERSISTED_SLOT_COUNT"
    HOST_CPU_LIMIT="$PERSISTED_HOST_CPU_LIMIT"
    HOST_MEMORY_GIB_LIMIT="$PERSISTED_HOST_MEMORY_GIB_LIMIT"
  fi
}

require_supervisor_capacity_matches_persisted() {
  if [[ "$COMMAND" != supervise-slot || -z "$PERSISTED_SLOT_COUNT" ]]; then
    return 0
  fi
  if [[ "$SLOT_COUNT" != "$PERSISTED_SLOT_COUNT" ||
        "$HOST_CPU_LIMIT" != "$PERSISTED_HOST_CPU_LIMIT" ||
        "$HOST_MEMORY_GIB_LIMIT" != "$PERSISTED_HOST_MEMORY_GIB_LIMIT" ]]; then
    echo "Runner supervisor capacity differs from the active persisted configuration" >&2
    return 1
  fi
}

persist_capacity_configuration() {
  local temporary_config="${CAPACITY_CONFIG}.tmp.$$"
  {
    printf '%s\n' "$SLOT_COUNT"
    printf '%s\n' "$HOST_CPU_LIMIT"
    printf '%s\n' "$HOST_MEMORY_GIB_LIMIT"
  } >"$temporary_config"
  chmod 0600 "$temporary_config"
  mv -f "$temporary_config" "$CAPACITY_CONFIG"
}

configure_slots() {
  local required_cpus required_memory_gib slot
  load_capacity_configuration
  SLOT_COUNT="${SLOT_COUNT:-1}"
  HOST_CPU_LIMIT="${HOST_CPU_LIMIT:-$SLOT_CPUS}"
  HOST_MEMORY_GIB_LIMIT="${HOST_MEMORY_GIB_LIMIT:-$SLOT_MEMORY_GIB}"
  require_positive_integer "OPENSHAPEFORGE_RUNNER_SLOT_COUNT" "$SLOT_COUNT"
  require_positive_integer "OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT" "$HOST_CPU_LIMIT"
  require_positive_integer "OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT" "$HOST_MEMORY_GIB_LIMIT"
  require_supervisor_capacity_matches_persisted

  required_cpus=$((SLOT_COUNT * SLOT_CPUS))
  required_memory_gib=$((SLOT_COUNT * SLOT_MEMORY_GIB))
  if (( required_cpus > HOST_CPU_LIMIT )); then
    echo "Configured slots require ${required_cpus} CPUs but the declared host limit is ${HOST_CPU_LIMIT}" >&2
    return 1
  fi
  if (( required_memory_gib > HOST_MEMORY_GIB_LIMIT )); then
    echo "Configured slots require ${required_memory_gib} GiB but the declared host limit is ${HOST_MEMORY_GIB_LIMIT} GiB" >&2
    return 1
  fi

  SLOTS=()
  for ((slot = 1; slot <= SLOT_COUNT; slot++)); do
    SLOTS+=("$slot")
  done
}

slot_is_configured() {
  local requested="$1"
  [[ "$requested" =~ ^[1-9][0-9]*$ && ${#requested} -le 9 ]] &&
    (( requested <= SLOT_COUNT ))
}

profile_for() {
  printf 'osf-pr-%s' "$1"
}

runner_prefix_for() {
  printf '%s-%s-' "$RUNNER_NAME_PREFIX" "$1"
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

runner_file_for() {
  printf '%s/slot-%s.runner' "$SUPPORT_DIR" "$1"
}

machine_id_file_for() {
  printf '%s/slot-%s.machine-id' "$SUPPORT_DIR" "$1"
}

state_file_for() {
  printf '%s/slot-%s.state' "$SUPPORT_DIR" "$1"
}

pid_file_for() {
  printf '%s/slot-%s.pid' "$SUPPORT_DIR" "$1"
}

write_slot_state() {
  local slot="$1"
  local state="$2"
  mkdir -p "$SUPPORT_DIR"
  printf '%s\n' "$state" >"$(state_file_for "$slot")"
}

record_slot_identity() {
  local slot="$1"
  local runner_name="$2"
  local machine_id="$3"
  printf '%s\n' "$runner_name" >"$(runner_file_for "$slot")"
  printf '%s\n' "$machine_id" >"$(machine_id_file_for "$slot")"
}

clear_slot_identity() {
  local slot="$1"
  rm -f "$(runner_file_for "$slot")" "$(machine_id_file_for "$slot")"
}

verify_unique_machine_id() {
  local slot="$1"
  local machine_id="$2"
  local other_slot other_machine_id_file other_machine_id
  [[ "$machine_id" =~ ^[0-9a-f]{32}$ ]] || {
    echo "Runner slot ${slot} returned an invalid machine id" >&2
    return 1
  }
  for other_slot in "${SLOTS[@]}"; do
    [[ "$other_slot" == "$slot" ]] && continue
    other_machine_id_file="$(machine_id_file_for "$other_slot")"
    [[ -r "$other_machine_id_file" ]] || continue
    other_machine_id="$(cat "$other_machine_id_file")"
    if [[ "$other_machine_id" == "$machine_id" ]]; then
      echo "Runner slots ${slot} and ${other_slot} have the same machine id" >&2
      return 1
    fi
  done
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

delete_profile() {
  local profile="$1"
  local profiles status
  if ! profiles="$(colima list --json 2>/dev/null)"; then
    echo "Could not inspect Colima profile ${profile}" >&2
    return 1
  fi
  if [[ "$profiles" == *"\"name\":\"${profile}\""* ]]; then
    status="$(printf '%s\n' "$profiles" | jq -r --arg profile "$profile" \
      'select(.name == $profile) | .status // empty')"
    if [[ "$status" != "Stopped" ]]; then
      colima stop -p "$profile" >/dev/null 2>&1 || true
    fi
    if ! colima delete -p "$profile" --force >/dev/null; then
      echo "Could not delete Colima profile ${profile}" >&2
      return 1
    fi
  fi
  return 0
}

cleanup_slot() {
  local slot="$1"
  local prefix busy
  write_slot_state "$slot" cleaning
  prefix="$(runner_prefix_for "$slot")"
  if ! busy="$(
    gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
      --jq ".runners[] | select(.name | startswith(\"${prefix}\")) | select(.busy == true) | .name"
  )"; then
    write_slot_state "$slot" cleanup-failed
    echo "Could not verify runner state for slot ${slot}; refusing cleanup" >&2
    return 1
  fi
  if [[ -n "$busy" ]]; then
    write_slot_state "$slot" cleanup-failed
    echo "Refusing to delete busy runner slot ${slot}: ${busy}" >&2
    return 1
  fi
  delete_matching_runners "$prefix" || {
    write_slot_state "$slot" cleanup-failed
    return 1
  }
  delete_profile "$(profile_for "$slot")" || {
    write_slot_state "$slot" cleanup-failed
    return 1
  }
  clear_slot_identity "$slot"
  write_slot_state "$slot" idle
  return 0
}

disable_local_deploy_runner() {
  delete_matching_runners "$DISABLED_DEPLOY_RUNNER_PREFIX" || return 1
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
    command -v curl git mvn node npx wget unzip zstd jq iptables ip6tables dockerd-rootless-setuptool.sh >/dev/null
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
  colima -p "$profile" ssh -- bash -lc '
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

deny() {
  echo "Self-hosted runner policy denied this job before workflow steps ran." >&2
  exit 1
}

[[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]] || deny
[[ "${GITHUB_REPOSITORY:-}" == "$EXPECTED_REPOSITORY" ]] || deny
[[ -n "${GITHUB_EVENT_PATH:-}" && -r "$GITHUB_EVENT_PATH" ]] || deny

jq -e --arg repository "$EXPECTED_REPOSITORY" '"'"'
  .repository.full_name == $repository and
  .pull_request.base.repo.full_name == $repository and
  .pull_request.head.repo.full_name == $repository and
  .pull_request.head.repo.fork == false
'"'"' "$GITHUB_EVENT_PATH" >/dev/null || deny

echo "Self-hosted runner policy accepted a same-repository pull request."
POLICY
    sudo chown root:root /opt/openshapeforge-runner/pre-job-policy.sh
    sudo chmod 0755 /opt/openshapeforge-runner/pre-job-policy.sh
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
      "Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/openshapeforge-runner/pre-job-policy.sh" |
      sudo tee "/etc/systemd/system/${RUNNER_SERVICE}.d/rootless-docker.conf" >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl disable "$RUNNER_SERVICE" >/dev/null
  '
}

harden_and_start_runner() {
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
      systemctl start "$RUNNER_SERVICE"
    '\''
  '
}

verify_pre_job_policy() {
  local profile="$1"
  local service="$2"
  colima -p "$profile" ssh -- env RUNNER_SERVICE="$service" bash -lc '
    set -euo pipefail
    hook=/opt/openshapeforge-runner/pre-job-policy.sh
    [[ "$(stat -c "%u:%g:%a" "$hook")" == "0:0:755" ]] || {
      echo "Pre-job policy is not root-owned and executable" >&2
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
      GITHUB_REPOSITORY=OpenShapeForge/OpenShapeForge \
      GITHUB_EVENT_PATH="$policy_fixtures/same-repo.json" \
      "$hook" >/dev/null
    if env GITHUB_EVENT_NAME=pull_request \
      GITHUB_REPOSITORY=OpenShapeForge/OpenShapeForge \
      GITHUB_EVENT_PATH="$policy_fixtures/fork.json" \
      "$hook" >/dev/null 2>&1; then
      echo "Pre-job policy accepted a fork pull request" >&2
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
  LIMA_HOME="$lima_home" limactl start --tty=false "$instance" >/dev/null
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
  local profile runner_name runner_id machine_id service lifecycle_state
  profile="$(profile_for "$slot")"
  runner_name="$(runner_prefix_for "$slot")$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c 1-8)"

  require_host_isolation
  cleanup_slot "$slot" || return 1
  write_slot_state "$slot" provisioning
  colima start "$profile" \
    --cpus "$SLOT_CPUS" --memory "$SLOT_MEMORY_GIB" --root-disk 120 --arch aarch64 --runtime docker \
    --vm-type vz --mount none --ssh-agent=false --ssh-config=false \
    --activate=false --port-forwarder none \
    --dns 1.1.1.1 --dns 1.0.0.1 >/dev/null
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
  install_pre_job_policy "$profile"
  verify_guest_port_forwarding_disabled "$profile"

  require_host_isolation
  verify_host_network_boundary "$profile"
  machine_id="$(colima -p "$profile" ssh -- cat /etc/machine-id)"
  verify_unique_machine_id "$slot" "$machine_id"
  record_slot_identity "$slot" "$runner_name" "$machine_id"
  gh api --method POST "repos/${REPOSITORY}/actions/runners/registration-token" --jq .token |
    colima -p "$profile" ssh -- env RUNNER_NAME="$runner_name" bash -lc '
      set -euo pipefail
      read -r runner_token
      cd /opt/actions-runner
      ./config.sh --unattended --ephemeral --disableupdate \
        --url https://github.com/OpenShapeForge/OpenShapeForge \
        --token "$runner_token" --name "$RUNNER_NAME" \
        --labels osf-pr --work _work
      unset runner_token
    '
  runner_id="$(wait_for_repository_runner_id "$runner_name")"

  service="$(runner_service_for "$runner_name")"
  install_runner_service "$profile" "$service"
  verify_pre_job_policy "$profile" "$service"
  harden_and_start_runner "$profile" "$service"
  verify_unprivileged_runner "$profile" "$service"

  lifecycle_state="$(wait_for_runner_online_or_consumed \
    "$profile" "$service" "$runner_id" "$runner_name")"
  if [[ "$lifecycle_state" == online ]]; then
    write_slot_state "$slot" active
    echo "READY slot=${slot} runner=${runner_name} machine_id=${machine_id}"
    release_provision_lock
    if ! wait_for_ephemeral_runner_completion "$runner_id" "$runner_name"; then
      write_slot_state "$slot" lifecycle-failed
      return 1
    fi
  else
    release_provision_lock
  fi
  write_slot_state "$slot" completed
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
  release_provision_lock || true
  cleanup_slot_serialized "$slot" || true
  rm -f "$(pid_file_for "$slot")"
}

supervise_slot() {
  local slot="$1"
  local provision_result cleanup_result
  write_slot_state "$slot" starting
  printf '%s\n' "$$" >"$(pid_file_for "$slot")"
  trap 'cleanup_slot_on_exit "$slot"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_host_tools
  require_host_isolation
  ensure_runner_archive
  while true; do
    set +e
    provision_slot "$slot"
    provision_result=$?
    set -e
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
    <key>OPENSHAPEFORGE_RUNNER_SLOT</key><string>${slot}</string>
    <key>OPENSHAPEFORGE_RUNNER_SLOT_COUNT</key><string>${SLOT_COUNT}</string>
    <key>OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT</key><string>${HOST_CPU_LIMIT}</string>
    <key>OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT</key><string>${HOST_MEMORY_GIB_LIMIT}</string>
  </dict>
</dict></plist>
EOF
  plutil -lint "$plist" >/dev/null
}

verify_capacity_migration() {
  local slot prefix runners profiles supervisor_pid plist backup launch_agent_status
  local launch_agent_label launchctl_output launchctl_status expected_not_found
  local retired_plists=()
  local retired_backups=()
  if [[ -z "$PERSISTED_SLOT_COUNT" ]] || (( SLOT_COUNT >= PERSISTED_SLOT_COUNT )); then
    return 0
  fi

  if ! profiles="$(colima list --json 2>/dev/null)"; then
    echo "Could not inspect Colima profiles before reducing runner capacity" >&2
    return 1
  fi
  for ((slot = SLOT_COUNT + 1; slot <= PERSISTED_SLOT_COUNT; slot++)); do
    launch_agent_label="$(agent_label_for "$slot")"
    if launchctl_output="$(launchctl print "gui/${UID}/${launch_agent_label}" 2>&1)"; then
      launch_agent_status=0
    else
      launchctl_status=$?
      expected_not_found="Bad request."$'\n'"Could not find service \"${launch_agent_label}\" in domain for user gui: ${UID}"
      if (( launchctl_status == 113 )) && [[ "$launchctl_output" == "$expected_not_found" ]]; then
        launch_agent_status=1
      else
        echo "Could not inspect runner supervisor slot ${slot} with launchctl" \
          "(exit ${launchctl_status}): ${launchctl_output}" >&2
        return 1
      fi
    fi
    if (( launch_agent_status == 0 )); then
      echo "Refusing to retire active runner supervisor slot ${slot}; stop the old capacity first" >&2
      return 1
    fi
    supervisor_pid="$(cat "$(pid_file_for "$slot")" 2>/dev/null || true)"
    if [[ "$supervisor_pid" =~ ^[0-9]+$ ]] && kill -0 "$supervisor_pid" 2>/dev/null; then
      echo "Refusing to retire running runner process slot ${slot}; stop the old capacity first" >&2
      return 1
    fi
    prefix="$(runner_prefix_for "$slot")"
    if ! runners="$(gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
      --jq ".runners[] | select(.name | startswith(\"${prefix}\")) | .name")"; then
      echo "Could not verify repository runners before reducing runner capacity" >&2
      return 1
    fi
    if [[ -n "$runners" ]]; then
      echo "Refusing to retire registered runner slot ${slot}: ${runners}" >&2
      return 1
    fi
    if printf '%s\n' "$profiles" | jq -e --arg profile "$(profile_for "$slot")" \
      'select(.name == $profile)' >/dev/null; then
      echo "Refusing to retire existing Colima profile slot ${slot}; stop the old capacity first" >&2
      return 1
    fi
  done

  for ((slot = SLOT_COUNT + 1; slot <= PERSISTED_SLOT_COUNT; slot++)); do
    plist="$(plist_for "$slot")"
    [[ -e "$plist" ]] || continue
    backup="${plist}.retired.$$"
    if ! mv -f "$plist" "$backup"; then
      echo "Could not retire launch agent for slot ${slot}" >&2
      local restore_index
      for ((restore_index = 0; restore_index < ${#retired_plists[@]}; restore_index++)); do
        mv -f "${retired_backups[$restore_index]}" "${retired_plists[$restore_index]}" || true
      done
      return 1
    fi
    retired_plists+=("$plist")
    retired_backups+=("$backup")
  done
  if (( ${#retired_backups[@]} > 0 )); then
    for backup in "${retired_backups[@]}"; do
      unlink "$backup" || {
        echo "Could not remove retired launch agent backup: ${backup}" >&2
        return 1
      }
    done
  fi
}

start_supervisors() {
  require_host_isolation
  mkdir -p "$SUPPORT_DIR" "$LOG_DIR"
  verify_capacity_migration
  persist_capacity_configuration
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
  local attempt supervisor_pid
  supervisor_pid="$(cat "$(pid_file_for "$slot")" 2>/dev/null || true)"
  [[ "$supervisor_pid" =~ ^[0-9]+$ ]] || return 0
  for attempt in {1..50}; do
    if ! kill -0 "$supervisor_pid" 2>/dev/null; then
      return
    fi
    sleep 0.2
  done
  echo "Supervisor did not stop cleanly: slot ${slot}" >&2
  return 1
}

preflight_stop() {
  local slot prefix busy result=0
  for slot in "${SLOTS[@]}"; do
    prefix="$(runner_prefix_for "$slot")"
    if ! busy="$(
      gh api --paginate "repos/${REPOSITORY}/actions/runners?per_page=100" \
        --jq ".runners[] | select(.name | startswith(\"${prefix}\")) | select(.busy == true) | .name"
    )"; then
      echo "Could not verify runner state for slot ${slot}; supervisors remain active" >&2
      result=1
      continue
    fi
    if [[ -n "$busy" ]]; then
      echo "Refusing to stop busy runner slot ${slot}: ${busy}" >&2
      result=1
    fi
  done
  return "$result"
}

restore_supervisors() {
  local slot plist result=0
  for slot in "${SLOTS[@]}"; do
    plist="$(plist_for "$slot")"
    if ! launchctl print "gui/${UID}/$(agent_label_for "$slot")" >/dev/null 2>&1; then
      if ! launchctl bootstrap "gui/${UID}" "$plist"; then
        echo "Could not restore supervisor for slot ${slot}" >&2
        result=1
      fi
    fi
  done
  return "$result"
}

cleanup_configured_slots() {
  local slot result=0
  for slot in "${SLOTS[@]}"; do
    if cleanup_slot "$slot"; then
      echo "slot ${slot}: stopped and deleted"
    else
      result=1
    fi
  done
  if ! disable_local_deploy_runner; then
    result=1
  fi
  return "$result"
}

stop_supervisors() {
  local slot plist result=0 wait_result=0
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
  cleanup_configured_slots
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
  local slot profile runner_name service machine_id stored_machine_id repository_runner_names
  for slot in "${SLOTS[@]}"; do
    profile="$(profile_for "$slot")"
    runner_name="$(cat "$(runner_file_for "$slot")")"
    service="$(runner_service_for "$runner_name")"
    require_host_isolation
    verify_host_network_boundary "$profile"
    verify_guest_firewall_behavior "$profile"
    verify_fresh_vm "$profile"
    verify_rootless_docker_firewall_behavior "$profile"
    verify_pre_job_policy "$profile" "$service"
    verify_unprivileged_runner "$profile" "$service"
    stored_machine_id="$(cat "$(machine_id_file_for "$slot")")"
    machine_id="$(colima -p "$profile" ssh -- cat /etc/machine-id)"
    [[ "$machine_id" == "$stored_machine_id" ]] || {
      echo "Runner slot ${slot} machine id changed" >&2
      return 1
    }
    verify_unique_machine_id "$slot" "$machine_id"
    printf 'slot=%s machine_id=%s\n' "$slot" "$machine_id"
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
  configure_slots
  require_host_tools
  require_runner_identity_values

  case "$COMMAND" in
    start) start_supervisors ;;
    stop) stop_supervisors ;;
    status) show_status ;;
    verify) verify_slots ;;
    supervise-slot)
      local requested_slot="${OPENSHAPEFORGE_RUNNER_SLOT:-${2:-}}"
      slot_is_configured "$requested_slot" || {
        echo "supervise-slot requires a configured slot" >&2
        exit 2
      }
      supervise_slot "$requested_slot"
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
