// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNERS = join(import.meta.dir, "local-actions-runners.sh");
const PRE_JOB_POLICY = join(import.meta.dir, "self-hosted-pre-job-policy.sh");

async function runHarness(body: string, environment: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "osf-runner-lifecycle-"));
  const harness = join(home, "harness.sh");
  await writeFile(
    harness,
    `#!/usr/bin/env bash
set -euo pipefail
source ${JSON.stringify(RUNNERS)}
mkdir -p "$SUPPORT_DIR"

${body}
`,
  );

  try {
    return Bun.spawnSync(["bash", harness], {
      env: { ...process.env, ...environment, HOME: home },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

describe("ephemeral runner lifecycle", () => {
  test("accepts a runner consumed between registration polls", async () => {
    const result = await runHarness(`
repository_runner_state() {
  if [[ ! -e "$HOME/runner-polled" ]]; then
    touch "$HOME/runner-polled"
    printf 'offline:false\\n'
  fi
}
runner_service_active_state() {
  if [[ ! -e "$HOME/service-polled" ]]; then
    touch "$HOME/service-polled"
    printf 'active\\n'
  else
    printf 'inactive\\n'
  fi
}
sleep() { :; }
[[ "$(wait_for_runner_online_or_consumed profile service 42 runner)" == consumed ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("returns online without requiring a service exit", async () => {
    const result = await runHarness(`
repository_runner_state() { printf 'online:false\\n'; }
runner_service_active_state() { return 99; }
[[ "$(wait_for_runner_online_or_consumed profile service 42 runner)" == online ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("times out when a never-connected runner remains registered offline", async () => {
    const result = await runHarness(`
repository_runner_state() { printf 'offline:false\\n'; }
runner_service_active_state() { printf 'inactive\\n'; }
sleep() { :; }
if wait_for_runner_online_or_consumed profile service 42 runner; then
  exit 1
fi
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Runner neither became online nor completed successfully",
    );
  });

  test("does not infer consumption when the repository API fails", async () => {
    const result = await runHarness(`
repository_runner_state() { return 1; }
runner_service_active_state() { printf 'inactive\\n'; }
sleep() { :; }
if wait_for_runner_online_or_consumed profile service 42 runner; then
  exit 1
fi
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Runner neither became online nor completed successfully",
    );
  });

  test("queries known runner state by id instead of a partial inventory", async () => {
    const result = await runHarness(`
gh() {
  [[ "$*" == *"actions/runners/42"* ]]
  printf 'online:false\n'
}
[[ "$(repository_runner_state 42)" == online:false ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });
});

describe("isolation invariants", () => {
  test("embeds the exact reviewed pre-job policy", async () => {
    const [source, policy] = await Promise.all([
      readFile(RUNNERS, "utf8"),
      readFile(PRE_JOB_POLICY, "utf8"),
    ]);
    const marker = `<<'"'"'POLICY'"'"'\n`;
    const start = source.indexOf(marker);
    const end = source.indexOf("\nPOLICY\n", start + marker.length);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const embedded = source
      .slice(start + marker.length, end)
      .replaceAll(`'"'"'`, "'");
    expect(`${embedded}\n`).toBe(policy);
  });

  test("defaults to one slot, ephemeral registration and serialized cleanup", async () => {
    const source = await readFile(RUNNERS, "utf8");
    expect(source).toContain('SLOT_COUNT="${OPENSHAPEFORGE_RUNNER_SLOT_COUNT:-}"');
    expect(source).toContain('SLOT_COUNT="${SLOT_COUNT:-1}"');
    expect(source).toContain("./config.sh --unattended --ephemeral --disableupdate");
    expect(source).toContain(`cleanup_slot_serialized() (
  local slot="$1"
  local result
  acquire_provision_lock`);
  });

  test("disables forwarding and proves the live boundary before registration", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const provisionStart = source.indexOf("provision_slot_locked() {");
    const provisionEnd = source.indexOf("\nprovision_slot() (", provisionStart);
    const provision = source.slice(provisionStart, provisionEnd);
    const forwardingFlag = provision.indexOf("--port-forwarder none");
    const loopbackHardening = provision.indexOf(
      'harden_colima_loopback_forwarding "$profile"',
    );
    const liveProof = provision.indexOf(
      'verify_guest_port_forwarding_disabled "$profile"',
    );
    const tokenRequest = provision.indexOf("actions/runners/registration-token");

    expect(provisionStart).toBeGreaterThanOrEqual(0);
    expect(provisionEnd).toBeGreaterThan(provisionStart);
    expect(forwardingFlag).toBeGreaterThanOrEqual(0);
    expect(loopbackHardening).toBeGreaterThan(forwardingFlag);
    expect(liveProof).toBeGreaterThan(loopbackHardening);
    expect(tokenRequest).toBeGreaterThan(liveProof);
  });

  test("uses a deterministic guest probe and preserves failure diagnostics", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const start = source.indexOf("verify_guest_port_forwarding_disabled() {");
    const end = source.indexOf("\n# macOS skips PF", start);
    const verification = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(verification).toContain("nohup /usr/local/bin/node");
    expect(verification).toContain(
      '[Number(process.env.WILDCARD_PROBE_PORT), "0.0.0.0"]',
    );
    expect(verification).toContain(
      '[Number(process.env.IPV4_LOOPBACK_PROBE_PORT), "127.0.0.1"]',
    );
    expect(verification).toContain(
      '[Number(process.env.IPV6_LOOPBACK_PROBE_PORT), "::1"]',
    );
    expect(verification).toContain(
      'if [[ "$wildcard_response" == ready && "$ipv4_response" == ready &&',
    );
    expect(verification).toContain("probe_ready=1");
    expect(verification).toContain(
      "Guest port-forwarding probe setup failed; guest diagnostics follow",
    );
    expect(verification).toContain('sed -n "1,80p" "$log_file"');
  });

  test("adds explicit IPv4 and IPv6 loopback denies before restarting Lima", async () => {
    const result = await runHarness(`
export COLIMA_HOME="$HOME/.colima"
config="$COLIMA_HOME/_lima/colima-profile/lima.yaml"
mkdir -p "$(dirname "$config")"
cat >"$config" <<'YAML'
vmType: vz
portForwards:
    - guestIP: 0.0.0.0
      proto: any
      ignore: true
YAML
limactl() {
  printf '%s\n' "$*" >>"$HOME/limactl-calls"
}
harden_colima_loopback_forwarding profile
grep -Fq 'guestIP: 127.0.0.1' "$config"
grep -Fq 'guestIP: ::1' "$config"
grep -Fq 'stop colima-profile' "$HOME/limactl-calls"
grep -Fq 'start --tty=false colima-profile' "$HOME/limactl-calls"
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("leaves the VM stopped when the generated forwarding config is unexpected", async () => {
    const result = await runHarness(`
export COLIMA_HOME="$HOME/.colima"
config="$COLIMA_HOME/_lima/colima-profile/lima.yaml"
mkdir -p "$(dirname "$config")"
printf 'vmType: vz\n' >"$config"
limactl() {
  printf '%s\n' "$*" >>"$HOME/limactl-calls"
}
set +e
harden_colima_loopback_forwarding profile
harden_result=$?
set -e
(( harden_result != 0 ))
grep -Fq 'stop colima-profile' "$HOME/limactl-calls"
! grep -Fq 'start --tty=false colima-profile' "$HOME/limactl-calls"
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Generated Lima forwarding config is not in the expected shape",
    );
  });

  test("does not classify an lsof inspection error as an unbound host port", async () => {
    const result = await runHarness(`
lsof() {
  printf 'listener inspection failed\n' >&2
  return 1
}
[[ "$(host_tcp_port_state 49152)" == error ]]
set +e
assert_host_tcp_port_unbound 49152
assert_result=$?
set -e
(( assert_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not prove that TCP port 49152 is unbound on the Mac",
    );
  });

  test("does not inspect or accept a host port when its error log cannot be created", async () => {
    const result = await runHarness(`
mktemp() { return 1; }
lsof() {
  touch "$HOME/lsof-called"
  return 1
}
[[ "$(host_tcp_port_state 49152)" == error ]]
[[ ! -e "$HOME/lsof-called" ]]
set +e
select_forwarding_probe_port 49152
selection_result=$?
set -e
(( selection_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not inspect candidate forwarding probe ports on the Mac",
    );
  });

  test("fails the live proof closed when a wildcard host listener appears", async () => {
    const result = await runHarness(`
lsof() {
  calls="$(cat "$HOME/lsof-calls" 2>/dev/null || printf 0)"
  calls="$((calls + 1))"
  printf '%s\n' "$calls" >"$HOME/lsof-calls"
  if (( calls <= 6 )); then
    return 1
  fi
  printf 'hostagent 42 user 10u IPv4 TCP *:49152 (LISTEN)\\n'
}
nc() { return 1; }
sleep() { :; }
colima() {
  printf '%s\\n' "$*" >>"$HOME/colima-calls"
  return 0
}
set +e
verify_guest_port_forwarding_disabled profile
verify_result=$?
set -e
(( verify_result != 0 ))
grep -Fq 'openshapeforge-forwarding-probe.pid' "$HOME/colima-calls"
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "TCP port 49152 is bound on the Mac; forwarding proof cannot continue",
    );
  });

  test("selects an unbound port, accepts the isolated listener and removes it", async () => {
    const result = await runHarness(`
lsof() {
  if [[ "$*" == *'-iTCP:49152'* ]]; then
    printf 'service 43 user 10u IPv4 TCP *:49152 (LISTEN)\\n'
    return 0
  fi
  return 1
}
nc() {
  printf '%s\\n' "$*" >>"$HOME/nc-calls"
  return 1
}
sleep() { :; }
colima() {
  printf '%s\\n' "$*" >>"$HOME/colima-calls"
  return 0
}
verify_guest_port_forwarding_disabled profile
grep -Fq -- '-z 127.0.0.1 49153' "$HOME/nc-calls"
grep -Fq -- '-z ::1 49153' "$HOME/nc-calls"
grep -Fq -- '-z 127.0.0.1 49154' "$HOME/nc-calls"
grep -Fq -- '-z ::1 49154' "$HOME/nc-calls"
grep -Fq -- '-z 127.0.0.1 49155' "$HOME/nc-calls"
grep -Fq -- '-z ::1 49155' "$HOME/nc-calls"
grep -Fq 'kill "$pid"' "$HOME/colima-calls"
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("verifies durable service identity after a fast runner exit", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const start = source.indexOf("verify_unprivileged_runner() {");
    const end = source.indexOf("\nverify_host_network_boundary() {", start);
    const verification = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(verification).toContain('-p User --value');
    expect(verification).toContain('-p SupplementaryGroups --value');
    expect(verification).not.toContain("Runner.Listener");
  });

  test("runs exit cleanup when the process no longer owns a lock", async () => {
    const result = await runHarness(`
cleanup_slot_serialized() { touch "$HOME/cleanup-ran"; }
cleanup_slot_on_exit 1
[[ -e "$HOME/cleanup-ran" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("persists validated runner identity overrides in the launch agent", async () => {
    const result = await runHarness(
      `
plutil() { :; }
write_launch_agent 1
plist="$(plist_for 1)"
grep -Fq '<key>OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP</key><string>_reviewers</string>' "$plist"
grep -Fq '<key>OPENSHAPEFORGE_RUNNER_NAME_PREFIX</key><string>review-pr</string>' "$plist"
grep -Fq '<key>OPENSHAPEFORGE_DEPLOY_RUNNER_PREFIX</key><string>review-deploy</string>' "$plist"
`,
      {
        OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP: "_reviewers",
        OPENSHAPEFORGE_RUNNER_NAME_PREFIX: "review-pr",
        OPENSHAPEFORGE_DEPLOY_RUNNER_PREFIX: "review-deploy",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("rejects runner identity overrides that are unsafe in host paths or XML", async () => {
    const result = await runHarness(
      `
plutil() { :; }
if write_launch_agent 1; then
  exit 1
fi
`,
      { OPENSHAPEFORGE_RUNNER_NAME_PREFIX: "review<runner" },
    );

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "OPENSHAPEFORGE_RUNNER_NAME_PREFIX must contain only",
    );
  });

  test("cleanup still refuses to delete a busy runner", async () => {
    const result = await runHarness(`
gh() {
  [[ "$*" == *"--paginate"* ]]
  [[ "$*" == *"actions/runners?per_page=100"* ]]
  printf 'runner-busy\\n'
}
delete_matching_runners() { touch "$HOME/deleted-runner"; }
delete_profile() { touch "$HOME/deleted-profile"; }
set +e
cleanup_slot 1
cleanup_result=$?
set -e
(( cleanup_result != 0 ))
[[ ! -e "$HOME/deleted-runner" ]]
[[ ! -e "$HOME/deleted-profile" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain("Refusing to delete busy runner slot 1");
  });
  test("restores the supervisor when it misses the stop deadline", async () => {
    const result = await runHarness(`
configure_slots
preflight_stop() { :; }
wait_for_supervisor_exit() { return 1; }
cleanup_slot() { touch "$HOME/cleanup-ran"; }
disable_local_deploy_runner() { touch "$HOME/deploy-cleanup-ran"; }
launchctl() {
  if [[ "$1" == print ]]; then
    return 1
  fi
  if [[ "$1" == bootstrap ]]; then
    touch "$HOME/supervisor-restored"
  fi
}
set +e
stop_supervisors
stop_result=$?
set -e
(( stop_result != 0 ))
[[ -e "$HOME/supervisor-restored" ]]
[[ ! -e "$HOME/cleanup-ran" ]]
[[ ! -e "$HOME/deploy-cleanup-ran" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "A supervisor did not stop cleanly; restoring all configured supervisors",
    );
  });

  test("fails verify closed when the complete runner inventory is unavailable", async () => {
    const result = await runHarness(`
configure_slots
require_host_isolation() { :; }
verify_host_network_boundary() { :; }
verify_guest_firewall_behavior() { :; }
verify_fresh_vm() { :; }
verify_rootless_docker_firewall_behavior() { :; }
verify_pre_job_policy() { :; }
verify_unprivileged_runner() { :; }
colima() { :; }
printf 'runner-one\n' >"$SUPPORT_DIR/slot-1.runner"
gh() { return 1; }
set +e
verify_slots
verify_result=$?
set -e
(( verify_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not verify the repository runner inventory",
    );
  });
  test("builds two isolated slots only with declared host capacity", async () => {
    const result = await runHarness(
      `
configure_slots
(( \${#SLOTS[@]} == 2 ))
[[ "\${SLOTS[*]}" == "1 2" ]]
[[ "$(profile_for 1)" == osf-pr-1 ]]
[[ "$(profile_for 2)" == osf-pr-2 ]]
[[ "$(runner_prefix_for 1)" == openshapeforge-pr-1- ]]
[[ "$(runner_prefix_for 10)" == openshapeforge-pr-10- ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("refuses CPU overcommit", async () => {
    const result = await runHarness("configure_slots", {
      OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
      OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "11",
      OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Configured slots require 12 CPUs but the declared host limit is 11",
    );
  });

  test("fails closed when multiple slots omit host capacity", async () => {
    const result = await runHarness("configure_slots", {
      OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Runner capacity overrides must set slot count, CPU limit and memory limit together",
    );
  });

  test("refuses to lower persisted capacity while a retired supervisor is active", async () => {
    const result = await runHarness(
      `
printf '2\\n12\\n28\\n' >"$CAPACITY_CONFIG"
configure_slots
launchctl() {
  [[ "$1" == print && "$2" == *pr-2 ]]
}
colima() { [[ "$1" == list ]] && return 0; }
gh() { :; }
if verify_capacity_migration; then
  exit 1
fi
[[ "$(cat "$CAPACITY_CONFIG")" == $'2\n12\n28' ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "1",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "6",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "14",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Refusing to retire active runner supervisor slot 2",
    );
  });

  test("reuses persisted capacity so stop cannot forget a configured slot", async () => {
    const result = await runHarness(
      `
configure_slots
persist_capacity_configuration
SLOT_COUNT=""
HOST_CPU_LIMIT=""
HOST_MEMORY_GIB_LIMIT=""
SLOTS=()
configure_slots
[[ "\${SLOTS[*]}" == "1 2" ]]
[[ "$SLOT_COUNT" == 2 ]]
[[ "$HOST_CPU_LIMIT" == 12 ]]
[[ "$HOST_MEMORY_GIB_LIMIT" == 28 ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("fails closed on incomplete persisted capacity", async () => {
    const result = await runHarness(`
printf '2\\n12\\n' >"$CAPACITY_CONFIG"
configure_slots
`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Runner capacity configuration is incomplete");
  });

  test("refuses memory overcommit", async () => {
    const result = await runHarness("configure_slots", {
      OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
      OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
      OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "27",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Configured slots require 28 GiB but the declared host limit is 27 GiB",
    );
  });

  test("keeps runner, machine and lifecycle state separate per slot", async () => {
    const result = await runHarness(
      `
configure_slots
machine_one=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
machine_two=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
record_slot_identity 1 "$(runner_prefix_for 1)one" "$machine_one"
write_slot_state 1 active
verify_unique_machine_id 2 "$machine_two"
if verify_unique_machine_id 2 "$machine_one"; then
  exit 1
fi
record_slot_identity 2 "$(runner_prefix_for 2)two" "$machine_two"
write_slot_state 2 active
[[ "$(cat "$(runner_file_for 1)")" != "$(cat "$(runner_file_for 2)")" ]]
[[ "$(cat "$(machine_id_file_for 1)")" != "$(cat "$(machine_id_file_for 2)")" ]]
[[ "$(state_file_for 1)" != "$(state_file_for 2)" ]]
[[ "$(cat "$(state_file_for 1)")" == active ]]
[[ "$(cat "$(state_file_for 2)")" == active ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Runner slots 2 and 1 have the same machine id",
    );
  });

  test("allows two active slots while provisioning remains serialized", async () => {
    const result = await runHarness(
      `
configure_slots
acquire_provision_lock() {
  until mkdir "$HOME/test-provision.lock" 2>/dev/null; do
    command sleep 0.01
  done
}
release_provision_lock() {
  rmdir "$HOME/test-provision.lock" 2>/dev/null || true
}
provision_slot_locked() {
  local slot="$1"
  local other_slot=$((3 - slot))
  [[ ! -e "$HOME/in-provisioning" ]]
  printf '%s\n' "$slot" >"$HOME/in-provisioning"
  if [[ -e "$HOME/slot-\${other_slot}.active" ]]; then
    touch "$HOME/provisioned-alongside-active"
  fi
  rm "$HOME/in-provisioning"
  write_slot_state "$slot" active
  touch "$HOME/slot-\${slot}.active"
  release_provision_lock
  for attempt in {1..100}; do
    [[ -e "$HOME/slot-1.active" && -e "$HOME/slot-2.active" ]] && return 0
    command sleep 0.01
  done
  return 1
}
provision_slot 1 &
slot_one_pid=$!
provision_slot 2 &
slot_two_pid=$!
wait "$slot_one_pid"
wait "$slot_two_pid"
[[ -e "$HOME/provisioned-alongside-active" ]]
[[ "$(cat "$(state_file_for 1)")" == active ]]
[[ "$(cat "$(state_file_for 2)")" == active ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("writes each launch agent with its own validated slot configuration", async () => {
    const result = await runHarness(
      `
configure_slots
plutil() { :; }
write_launch_agent 1
write_launch_agent 2
slot_one_plist="$(plist_for 1)"
slot_two_plist="$(plist_for 2)"
grep -Fq '<key>OPENSHAPEFORGE_RUNNER_SLOT</key><string>1</string>' "$slot_one_plist"
grep -Fq '<key>OPENSHAPEFORGE_RUNNER_SLOT</key><string>2</string>' "$slot_two_plist"
grep -Fq '<key>OPENSHAPEFORGE_RUNNER_SLOT_COUNT</key><string>2</string>' "$slot_one_plist"
grep -Fq '<key>OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT</key><string>12</string>' "$slot_two_plist"
grep -Fq '<key>OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT</key><string>28</string>' "$slot_two_plist"
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("checks every slot before refusing a busy-runner stop", async () => {
    const result = await runHarness(
      `
configure_slots
gh() {
  if [[ "$*" == *"openshapeforge-pr-2-"* ]]; then
    printf 'slot-two-busy\n'
  fi
}
set +e
preflight_stop
preflight_result=$?
set -e
(( preflight_result != 0 ))
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Refusing to stop busy runner slot 2: slot-two-busy",
    );
  });

  test("isolates cleanup failure so every configured slot is attempted", async () => {
    const result = await runHarness(
      `
configure_slots
cleanup_slot() {
  printf '%s\n' "$1" >>"$HOME/cleanup-attempts"
  [[ "$1" != 1 ]]
}
disable_local_deploy_runner() { return 0; }
set +e
cleanup_configured_slots
cleanup_result=$?
set -e
(( cleanup_result != 0 ))
[[ "$(cat "$HOME/cleanup-attempts")" == $'1\n2' ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stdout.toString()).toContain("slot 2: stopped and deleted");
  });

  test("restores every slot when one supervisor misses the stop deadline", async () => {
    const result = await runHarness(
      `
configure_slots
preflight_stop() { :; }
wait_for_supervisor_exit() { [[ "$1" != 1 ]]; }
cleanup_configured_slots() { touch "$HOME/cleanup-ran"; }
launchctl() {
  if [[ "$1" == print ]]; then
    return 1
  fi
  if [[ "$1" == bootstrap ]]; then
    printf '%s\\n' "$3" >>"$HOME/restore-attempts"
    [[ "$3" != *pr-1.plist ]]
    return
  fi
}
set +e
stop_supervisors
stop_result=$?
set -e
(( stop_result != 0 ))
[[ ! -e "$HOME/cleanup-ran" ]]
[[ "$(wc -l <"$HOME/restore-attempts" | tr -d ' ')" == 2 ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "A supervisor did not stop cleanly; restoring all configured supervisors",
    );
    expect(result.stderr.toString()).toContain("Could not restore supervisor for slot 1");
  });

  test("queries known runner state by id instead of a first-page inventory", async () => {
    const result = await runHarness(`
gh() {
  [[ "$*" == *"actions/runners/42"* ]]
  printf 'online:false\\n'
}
[[ "$(repository_runner_state 42)" == online:false ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("cleans slot state on supervisor exit even when it owns no shared lock", async () => {
    const result = await runHarness(`
printf '%s\n' 123 >"$(pid_file_for 1)"
cleanup_slot_serialized() { touch "$HOME/cleanup-attempted"; }
cleanup_slot_on_exit 1
[[ -e "$HOME/cleanup-attempted" ]]
[[ ! -e "$(pid_file_for 1)" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("verifies firewall and admission boundaries independently per slot", async () => {
    const result = await runHarness(
      `
configure_slots
record_slot_identity 1 runner-one aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
record_slot_identity 2 runner-two bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
require_host_isolation() { printf 'host-isolation\n' >>"$HOME/checks"; }
verify_host_network_boundary() { printf 'host:%s\n' "$1" >>"$HOME/checks"; }
verify_guest_firewall_behavior() { printf 'guest:%s\n' "$1" >>"$HOME/checks"; }
verify_fresh_vm() { printf 'fresh:%s\n' "$1" >>"$HOME/checks"; }
verify_rootless_docker_firewall_behavior() { printf 'rootless:%s\n' "$1" >>"$HOME/checks"; }
verify_pre_job_policy() { printf 'admission:%s\n' "$1" >>"$HOME/checks"; }
verify_unprivileged_runner() { printf 'unprivileged:%s\n' "$1" >>"$HOME/checks"; }
colima() {
  if [[ "$*" == *"osf-pr-1"* ]]; then
    printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  else
    printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
  fi
}
gh() { :; }
verify_slots
[[ "$(grep -c '^guest:' "$HOME/checks")" == 2 ]]
[[ "$(grep -c '^rootless:' "$HOME/checks")" == 2 ]]
[[ "$(grep -c '^admission:' "$HOME/checks")" == 2 ]]
`,
      {
        OPENSHAPEFORGE_RUNNER_SLOT_COUNT: "2",
        OPENSHAPEFORGE_RUNNER_HOST_CPU_LIMIT: "12",
        OPENSHAPEFORGE_RUNNER_HOST_MEMORY_GIB_LIMIT: "28",
      },
    );

    expect(result.exitCode, output(result)).toBe(0);
  });
});
