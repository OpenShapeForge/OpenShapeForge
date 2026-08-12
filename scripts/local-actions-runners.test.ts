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

  test("keeps one slot, ephemeral registration and serialized cleanup", async () => {
    const source = await readFile(RUNNERS, "utf8");
    expect(source).toContain("readonly SLOTS=(1)");
    expect(source).toContain("./config.sh --unattended --ephemeral --disableupdate");
    expect(source).toContain(`cleanup_slot_serialized() (
  local slot="$1"
  local result
  acquire_provision_lock`);
  });

  test("keeps native ARM64 runners and proves amd64 execution before registration", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const start = source.indexOf("provision_slot_locked() {");
    const end = source.indexOf("\nprovision_slot() (", start);
    const provisioning = source.slice(start, end);
    const freshVm = provisioning.indexOf('verify_fresh_vm "$profile"');
    const crossArchitecture = provisioning.indexOf(
      'verify_cross_architecture_container_execution "$profile"',
    );
    const registrationToken = provisioning.indexOf(
      "actions/runners/registration-token",
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(provisioning).toContain("--arch aarch64 --runtime docker");
    expect(provisioning).toContain(
      "--vm-type vz --vz-rosetta --binfmt --mount none",
    );
    expect(provisioning).not.toContain("--arch x86_64");
    expect(freshVm).toBeGreaterThanOrEqual(0);
    expect(crossArchitecture).toBeGreaterThan(freshVm);
    expect(registrationToken).toBeGreaterThan(crossArchitecture);
  });

  test("accepts a rootless linux/amd64 container that executes as x86_64", async () => {
    const result = await runHarness(`
docker() {
  printf '%s\\n' "$*" >>"$HOME/docker-calls"
  case "$*" in
    "pull --platform linux/amd64 alpine:3.20"|"pull --platform linux/arm64 alpine:3.20") ;;
    "image inspect --format {{.Architecture}} alpine:3.20") printf 'amd64\\n' ;;
    "run --rm --platform linux/amd64 alpine:3.20 /bin/uname -m") printf 'x86_64\\n' ;;
    *) return 1 ;;
  esac
}
export -f docker
colima() {
  [[ "$1" == -p && "$2" == profile && "$3" == ssh && "$4" == -- ]]
  [[ "$5" == bash && "$6" == -lc ]]
  bash -lc "$7"
}
verify_cross_architecture_container_execution profile
grep -Fxq 'pull --platform linux/amd64 alpine:3.20' "$HOME/docker-calls"
grep -Fxq 'run --rm --platform linux/amd64 alpine:3.20 /bin/uname -m' "$HOME/docker-calls"
[[ "$(tail -n 1 "$HOME/docker-calls")" == 'pull --platform linux/arm64 alpine:3.20' ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("fails admission when linux/amd64 execution is unavailable", async () => {
    const result = await runHarness(`
docker() {
  printf '%s\\n' "$*" >>"$HOME/docker-calls"
  case "$*" in
    "pull --platform linux/amd64 alpine:3.20"|"pull --platform linux/arm64 alpine:3.20") ;;
    "image inspect --format {{.Architecture}} alpine:3.20") printf 'amd64\\n' ;;
    "run --rm --platform linux/amd64 alpine:3.20 /bin/uname -m") return 126 ;;
    *) return 1 ;;
  esac
}
export -f docker
colima() {
  [[ "$1" == -p && "$2" == profile && "$3" == ssh && "$4" == -- ]]
  [[ "$5" == bash && "$6" == -lc ]]
  bash -lc "$7"
}
if verify_cross_architecture_container_execution profile; then
  exit 1
fi
[[ "$(tail -n 1 "$HOME/docker-calls")" == 'pull --platform linux/arm64 alpine:3.20' ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Runner pre-admission cannot execute linux/amd64 containers",
    );
  });

  test("disables forwarding and proves the live boundary before registration", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const provisionStart = source.indexOf("provision_slot_locked() {");
    const provisionEnd = source.indexOf("\nprovision_slot() (", provisionStart);
    const provision = source.slice(provisionStart, provisionEnd);
    const forwardingFlag = provision.indexOf("--port-forwarder none");
    const liveProof = provision.indexOf(
      'verify_guest_port_forwarding_disabled "$profile"',
    );
    const tokenRequest = provision.indexOf("actions/runners/registration-token");

    expect(provisionStart).toBeGreaterThanOrEqual(0);
    expect(provisionEnd).toBeGreaterThan(provisionStart);
    expect(forwardingFlag).toBeGreaterThanOrEqual(0);
    expect(liveProof).toBeGreaterThan(forwardingFlag);
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
    expect(verification).toContain('if [[ "$response" == ready ]]; then');
    expect(verification).toContain("probe_ready=1");
    expect(verification).toContain(
      "Guest port-forwarding probe setup failed; guest diagnostics follow",
    );
    expect(verification).toContain('sed -n "1,80p" "$log_file"');
  });

  test("fails the live proof closed when a wildcard host listener appears", async () => {
    const result = await runHarness(`
lsof() {
  calls="$(cat "$HOME/lsof-calls" 2>/dev/null || printf 0)"
  calls="$((calls + 1))"
  printf '%s\n' "$calls" >"$HOME/lsof-calls"
  if (( calls <= 2 )); then
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
});
