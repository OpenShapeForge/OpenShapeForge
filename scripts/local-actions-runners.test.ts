// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitForFile(path: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processExists(pid: string) {
  return Bun.spawnSync(["/bin/kill", "-0", pid]).exitCode === 0;
}

async function runSupervisorSignal(
  signal: "SIGINT" | "SIGTERM",
  cleanupResult = 0,
  ignoreTerm = false,
) {
  const home = await mkdtemp(join(tmpdir(), "osf-runner-supervisor-signal-"));
  const harness = join(home, "harness.sh");
  const provisionReady = join(home, "provision-ready");
  await writeFile(
    harness,
    `#!/bin/bash
set -euo pipefail
source ${JSON.stringify(RUNNERS)}
mkdir -p "$SUPPORT_DIR"
readonly CLEANUP_RESULT=${cleanupResult}
require_host_tools() { :; }
require_host_isolation() { :; }
ensure_runner_archive() { :; }
acquire_provision_lock() {
  printf 'acquire\\n' >>"$HOME/cleanup-lifecycle"
}
release_provision_lock() {
  printf 'release\\n' >>"$HOME/cleanup-lifecycle"
}
cleanup_slot() {
  printf 'cleanup:%s\\n' "$1" >>"$HOME/cleanup-lifecycle"
  return "$CLEANUP_RESULT"
}
provision_slot() {
  if (( ${ignoreTerm ? 1 : 0} )); then
    trap '' TERM
  fi
  /bin/bash -c '
set -euo pipefail
on_term() {
  exit 143
}
if (( ${ignoreTerm ? 1 : 0} )); then
  trap '' TERM
else
  trap on_term TERM
fi
printf "%s\\n" "$$" >"$HOME/provision-child.pid"
printf "%s\\n" "$PPID" >"$HOME/provision-pid"
touch "$HOME/provision-ready"
while true; do
  /bin/sleep 30 || :
done
' &
  wait "$!"
}
supervise_slot 1
`,
  );

  const subprocess = Bun.spawn(["/bin/bash", harness], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await waitForFile(provisionReady);
    subprocess.kill(signal);
    const exitCode = await Promise.race([
      subprocess.exited,
      Bun.sleep(3_000).then(() => null),
    ]);
    if (exitCode === null) {
      subprocess.kill("SIGKILL");
      await subprocess.exited;
      throw new Error(`Supervisor did not exit after ${signal}`);
    }
    const [stdout, stderr, cleanupLifecycle, provisionChildPid, provisionPid] =
      await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        readFile(join(home, "cleanup-lifecycle"), "utf8"),
        readFile(join(home, "provision-child.pid"), "utf8"),
        readFile(join(home, "provision-pid"), "utf8"),
      ]);
    return {
      cleanupLifecycle,
      exitCode,
      provisionChildPid: provisionChildPid.trim(),
      provisionChildAlive: processExists(provisionChildPid.trim()),
      provisionPid: provisionPid.trim(),
      provisionPidAlive: processExists(provisionPid.trim()),
      stderr,
      stdout,
    };
  } finally {
    if (subprocess.exitCode === null) {
      subprocess.kill("SIGKILL");
      await subprocess.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
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

  test("adds the routing label through the repository runner API", async () => {
    const result = await runHarness(`
gh() {
  printf '%s\n' "$*" >"$HOME/gh-call"
}
add_repository_runner_routing_label 42
grep -Fq -- '--method POST repos/OpenShapeForge/OpenShapeForge/actions/runners/42/labels' "$HOME/gh-call"
grep -Fq -- '--field labels[]=osf-pr' "$HOME/gh-call"
grep -Fq -- '--silent' "$HOME/gh-call"
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("fails closed when the routing label update fails", async () => {
    const result = await runHarness(`
gh() { return 1; }
if add_repository_runner_routing_label 42; then
  exit 1
fi
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not add routing label to repository runner 42",
    );
  });

  test("clears bootstrap labels through the repository runner API", async () => {
    const result = await runHarness(`
gh() {
  printf '%s\n' "$*" >"$HOME/gh-call"
}
clear_repository_runner_labels 42
grep -Fq -- '--method DELETE repos/OpenShapeForge/OpenShapeForge/actions/runners/42/labels' "$HOME/gh-call"
grep -Fq -- '--silent' "$HOME/gh-call"
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("fails closed when clearing bootstrap labels fails", async () => {
    const result = await runHarness(`
gh() { return 1; }
if clear_repository_runner_labels 42; then
  exit 1
fi
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not clear labels from repository runner 42",
    );
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

  test("starts the listener only after isolation verification and label admission", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const provisionStart = source.indexOf("provision_slot_locked() {");
    const provisionEnd = source.indexOf("\nprovision_slot() (", provisionStart);
    const provision = source.slice(provisionStart, provisionEnd);
    const runnerNameGeneration = provision.indexOf(
      'runner_name="$(runner_prefix_for "$slot")-$(uuidgen',
    );
    const bootstrapGeneration = provision.indexOf(
      'bootstrap_label="$(uuidgen | tr',
    );
    const bootstrapGenerationEnd = provision.indexOf(
      "\n",
      bootstrapGeneration,
    );
    const bootstrapAssignment = provision.slice(
      bootstrapGeneration,
      bootstrapGenerationEnd,
    );
    const registrationStart = provision.indexOf("./config.sh --unattended");
    const registrationEnd = provision.indexOf(
      'runner_id="$(wait_for_repository_runner_id',
      registrationStart,
    );
    const registration = provision.slice(registrationStart, registrationEnd);
    const labelClearing = provision.indexOf(
      'clear_repository_runner_labels "$runner_id"',
    );
    const serviceInstall = provision.indexOf(
      'install_runner_service "$profile" "$service"',
    );
    const preJobVerification = provision.indexOf(
      'verify_pre_job_policy "$profile" "$service"',
    );
    const preStartHardening = provision.indexOf(
      'harden_runner_before_start "$profile" "$service"',
    );
    const isolationVerification = provision.indexOf(
      'verify_unprivileged_runner "$profile" "$service"',
    );
    const labelAdmission = provision.indexOf(
      'add_repository_runner_routing_label "$runner_id"',
    );
    const serviceStart = provision.indexOf(
      'start_runner_service "$profile" "$service"',
    );
    const lifecyclePoll = provision.indexOf(
      'wait_for_runner_online_or_consumed',
    );

    expect(provisionStart).toBeGreaterThanOrEqual(0);
    expect(provisionEnd).toBeGreaterThan(provisionStart);
    expect(runnerNameGeneration).toBeGreaterThanOrEqual(0);
    expect(bootstrapGeneration).toBeGreaterThan(runnerNameGeneration);
    expect(bootstrapAssignment).not.toContain("cut -c 1-8");
    expect(provision).toContain(
      '[[ "$bootstrap_label" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]',
    );
    expect(provision).toContain('RUNNER_BOOTSTRAP_LABEL="$bootstrap_label"');
    expect(registrationStart).toBeGreaterThanOrEqual(0);
    expect(registrationEnd).toBeGreaterThan(registrationStart);
    expect(registration).toContain("--no-default-labels");
    expect(registration).toContain('--labels "$RUNNER_BOOTSTRAP_LABEL"');
    expect(provision).not.toContain("osf-bootstrap-quarantine");
    expect(registration).not.toContain("osf-pr");
    expect(labelClearing).toBeGreaterThan(registrationEnd);
    expect(serviceInstall).toBeGreaterThan(labelClearing);
    expect(preJobVerification).toBeGreaterThan(serviceInstall);
    expect(preStartHardening).toBeGreaterThan(preJobVerification);
    expect(isolationVerification).toBeGreaterThan(preStartHardening);
    expect(labelAdmission).toBeGreaterThan(isolationVerification);
    expect(serviceStart).toBeGreaterThan(labelAdmission);
    expect(lifecyclePoll).toBeGreaterThan(serviceStart);
    expect(provision).not.toContain("harden_and_start_runner");
  });

  test("keeps the listener absent throughout the bootstrap-label window", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const installStart = source.indexOf("install_runner_service() {");
    const installEnd = source.indexOf(
      "\nharden_runner_before_start() {",
      installStart,
    );
    const install = source.slice(installStart, installEnd);
    const hardeningStart = source.indexOf("harden_runner_before_start() {");
    const hardeningEnd = source.indexOf(
      "\nstart_runner_service() {",
      hardeningStart,
    );
    const hardening = source.slice(hardeningStart, hardeningEnd);
    const verificationStart = source.indexOf("verify_unprivileged_runner() {");
    const verificationEnd = source.indexOf(
      "\nverify_host_network_boundary() {",
      verificationStart,
    );
    const verification = source.slice(verificationStart, verificationEnd);
    const startStart = source.indexOf("start_runner_service() {");
    const startEnd = source.indexOf("\nverify_pre_job_policy() {", startStart);
    const start = source.slice(startStart, startEnd);

    expect(installStart).toBeGreaterThanOrEqual(0);
    expect(installEnd).toBeGreaterThan(installStart);
    expect(install).toContain('systemctl disable "$RUNNER_SERVICE"');
    expect(install).not.toContain('systemctl start "$RUNNER_SERVICE"');
    expect(install).toContain(
      "ExecStartPre=+/usr/bin/rm -f /etc/sudoers.d/openshapeforge-runner-start",
    );
    expect(hardeningStart).toBeGreaterThanOrEqual(0);
    expect(hardeningEnd).toBeGreaterThan(hardeningStart);
    expect(hardening).not.toContain('systemctl start "$RUNNER_SERVICE"');
    expect(hardening).not.toContain("Runner.Listener");
    expect(hardening).toContain(
      'NOPASSWD: /usr/bin/systemctl start %s\\n"',
    );
    expect(hardening).toContain(
      "visudo -cf /etc/sudoers.d/openshapeforge-runner-start",
    );
    expect(verification).toContain('systemctl is-active "$RUNNER_SERVICE"');
    expect(verification).toContain('!= "inactive"');
    expect(verification).toContain(
      'pgrep -f "^/opt/actions-runner/bin/Runner.Listener( |$)"',
    );
    expect(start).toContain(
      'sudo -n /usr/bin/systemctl start "$RUNNER_SERVICE"',
    );
    expect(start).toContain(
      "test ! -e /etc/sudoers.d/openshapeforge-runner-start",
    );
  });

  test("supervisor serializes cleanup after every provisioning result", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const provisionStart = source.indexOf("provision_slot() (");
    const provisionEnd = source.indexOf(
      "\ncleanup_slot_serialized() (",
      provisionStart,
    );
    const provision = source.slice(provisionStart, provisionEnd);
    const supervisorStart = source.indexOf("supervise_slot() {");
    const supervisorEnd = source.indexOf(
      "\nwrite_launch_agent() {",
      supervisorStart,
    );
    const supervisor = source.slice(supervisorStart, supervisorEnd);
    const provisioning = supervisor.indexOf('provision_slot "$slot"');
    const cleanup = supervisor.indexOf('cleanup_slot_serialized "$slot"');

    expect(provision).toContain('(set -e; provision_slot_locked "$slot")');
    expect(supervisor).toContain('install_supervisor_exit_traps "$slot"');
    expect(provisioning).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(provisioning);
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

  test("verifies inactive service and durable identity before listener start", async () => {
    const source = await readFile(RUNNERS, "utf8");
    const start = source.indexOf("verify_unprivileged_runner() {");
    const end = source.indexOf("\nverify_host_network_boundary() {", start);
    const verification = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(verification).toContain('-p User --value');
    expect(verification).toContain('-p SupplementaryGroups --value');
    expect(verification).toContain("Runner.Listener");
  });

  test("runs exit cleanup when the process no longer owns a lock", async () => {
    const result = await runHarness(`
cleanup_slot_serialized() { touch "$HOME/cleanup-ran"; }
cleanup_slot_on_exit 1
[[ -e "$HOME/cleanup-ran" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("captures the validated slot for normal Bash 3.2 EXIT cleanup", async () => {
    const home = await mkdtemp(join(tmpdir(), "osf-runner-supervisor-exit-"));
    const harness = join(home, "harness.sh");
    await writeFile(
      harness,
      `#!/bin/bash
set -euo pipefail
source ${JSON.stringify(RUNNERS)}
mkdir -p "$SUPPORT_DIR"
cleanup_slot_serialized() { printf '%s\\n' "$1" >>"$HOME/cleanup-calls"; }
install_supervisor_exit_traps 1
`,
    );

    try {
      const result = Bun.spawnSync(["/bin/bash", harness], {
        env: { ...process.env, HOME: home },
      });
      expect(result.exitCode, output(result)).toBe(0);
      expect(await readFile(join(home, "cleanup-calls"), "utf8")).toBe("1\n");
      expect(result.stderr.toString()).not.toContain("unbound variable");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("provisioning failure and normal exit both invoke serialized cleanup", async () => {
    const result = await runHarness(`
require_host_tools() { :; }
require_host_isolation() { :; }
ensure_runner_archive() { :; }
provision_slot() { return 1; }
cleanup_slot_serialized() {
  printf 'cleanup:%s\\n' "$1"
}
sleep() {
  [[ "$1" == 10 ]]
  exit 0
}
supervise_slot 1
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stdout.toString()).toBe("cleanup:1\ncleanup:1\n");
    expect(result.stderr.toString()).toContain("Slot 1 provisioning failed");
    expect(result.stderr.toString()).not.toContain("unbound variable");
  });

  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`${signal} terminates active provisioning before serialized cleanup`, async () => {
      const result = await runSupervisorSignal(signal);
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(exitCode);
      expect(result.provisionChildPid).not.toBe(result.provisionPid);
      expect(result.provisionPidAlive).toBe(false);
      expect(result.provisionChildAlive).toBe(false);
      expect(result.cleanupLifecycle).toBe(
        "release\nacquire\ncleanup:1\nrelease\n",
      );
      expect(result.stderr).not.toContain("unbound variable");
    });

    test(`${signal} force kills TERM-ignoring provisioning before cleanup`, async () => {
      const startedAt = Date.now();
      const result = await runSupervisorSignal(signal, 0, true);
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(exitCode);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.provisionChildPid).not.toBe(result.provisionPid);
      expect(result.provisionPidAlive).toBe(false);
      expect(result.provisionChildAlive).toBe(false);
      expect(result.cleanupLifecycle).toBe(
        "release\nacquire\ncleanup:1\nrelease\n",
      );
      expect(result.stderr).toContain(
        "did not stop after TERM; forcing termination",
      );
      expect(result.stderr).not.toContain("unbound variable");
    });

    test(`${signal} preserves its exit status when cleanup fails`, async () => {
      const result = await runSupervisorSignal(signal, 9);
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(exitCode);
      expect(result.provisionPidAlive).toBe(false);
      expect(result.provisionChildAlive).toBe(false);
      expect(result.cleanupLifecycle).toBe(
        "release\nacquire\ncleanup:1\nrelease\n",
      );
      expect(result.stderr).toContain(
        "Supervisor cleanup for slot 1 failed with status 9",
      );
      expect(result.stderr).not.toContain("unbound variable");
    });
  }

  test("rejects an unconfigured slot before installing traps", async () => {
    const result = await runHarness(`
set +e
install_supervisor_exit_traps 2
trap_result=$?
set -e
(( trap_result == 2 ))
[[ -z "$(trap -p EXIT)" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Refusing to supervise unconfigured slot: 2",
    );
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
