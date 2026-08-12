// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVED_SELF_HOSTED_ROUTES } from "./check-self-hosted-routing.mjs";

const RUNNERS = join(import.meta.dir, "local-actions-runners.sh");
const PRE_JOB_POLICY = join(import.meta.dir, "self-hosted-pre-job-policy.sh");
const REPO_ROOT = join(import.meta.dir, "..");
const WORKFLOW_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_WORKFLOW_SHA = "1111111111111111111111111111111111111111";
const MERGE_WORKFLOW_SHA = "2222222222222222222222222222222222222222";
const STALE_WORKFLOW_SHA = "3333333333333333333333333333333333333333";
const WORKFLOW_RUN_ID = 38301;
const PULL_REQUEST_NUMBER = 383;
const DIRECT_WORKFLOW_PATH = ".github/workflows/ci.yml";

function workflowRun(status = "queued") {
  return {
    id: WORKFLOW_RUN_ID,
    run_attempt: 1,
    event: "pull_request",
    status,
    path: DIRECT_WORKFLOW_PATH,
    head_sha: WORKFLOW_SHA,
    repository: { full_name: "OpenShapeForge/OpenShapeForge" },
    head_repository: { full_name: "OpenShapeForge/OpenShapeForge" },
    pull_requests: [
      {
        number: PULL_REQUEST_NUMBER,
        head: { sha: WORKFLOW_SHA },
        base: { sha: BASE_WORKFLOW_SHA },
      },
    ],
  };
}

function verifiedWorkflowRun(status = "queued") {
  return { ...workflowRun(status), referenced_workflows: [] };
}

function currentPullRequest(mergeCommitSha: string | null = MERGE_WORKFLOW_SHA) {
  return {
    number: PULL_REQUEST_NUMBER,
    state: "open",
    head: {
      sha: WORKFLOW_SHA,
      repo: { full_name: "OpenShapeForge/OpenShapeForge" },
    },
    base: {
      sha: BASE_WORKFLOW_SHA,
      repo: { full_name: "OpenShapeForge/OpenShapeForge" },
    },
    merge_commit_sha: mergeCommitSha,
  };
}

function hostAuthorizationApi(options: {
  activeStatus?: string;
  pages?: unknown;
  verifiedRun?: unknown;
  pullRequest?: unknown;
  failAt?: "enumeration" | "run" | "pull" | "content";
  modifiedWorkflowRefs?: string[];
} = {}) {
  const activeStatus = options.activeStatus ?? "queued";
  const pages =
    options.pages ?? [
      {
        total_count: 2,
        workflow_runs: [
          {
            id: WORKFLOW_RUN_ID - 1,
            event: "pull_request",
            status: "completed",
            repository: { full_name: "OpenShapeForge/OpenShapeForge" },
          },
          workflowRun(activeStatus),
        ],
      },
    ];
  const verifiedRun =
    options.verifiedRun ?? verifiedWorkflowRun(activeStatus);
  const pullRequest = options.pullRequest ?? currentPullRequest();
  const modifiedChecks = (options.modifiedWorkflowRefs ?? [])
    .map(
      (workflowSha) => `
  if [[ "$*" == *"contents/.github/workflows/ci.yml"* && "$*" == *"ref=${workflowSha}"* ]]; then
    printf 'modified workflow at ${workflowSha}\\n'
    return
  fi`,
    )
    .join("");

  return `
gh() {
  printf '%s\\n' "$*" >>"$HOME/gh-calls"
  if [[ "$*" == *"actions/runs?event=pull_request"* ]]; then
    ${options.failAt === "enumeration" ? "return 1" : `printf '%s\\n' ${JSON.stringify(JSON.stringify(pages))}; return`}
  fi
  if [[ "$*" == *"actions/runs/${WORKFLOW_RUN_ID}/attempts/1"* ]]; then
    ${options.failAt === "run" ? "return 1" : `printf '%s\\n' ${JSON.stringify(JSON.stringify(verifiedRun))}; return`}
  fi
  if [[ "$*" == *"pulls/${PULL_REQUEST_NUMBER}"* ]]; then
    ${options.failAt === "pull" ? "return 1" : `printf '%s\\n' ${JSON.stringify(JSON.stringify(pullRequest))}; return`}
  fi
  if [[ "$*" == *"contents/"* ]]; then
    ${options.failAt === "content" ? "return 1" : ":"}
  fi${modifiedChecks}
  case "$*" in
    *contents/.github/workflows/ci.yml*) cat ${JSON.stringify(join(REPO_ROOT, ".github/workflows/ci.yml"))} ;;
    *contents/.github/workflows/docker-api.yml*) cat ${JSON.stringify(join(REPO_ROOT, ".github/workflows/docker-api.yml"))} ;;
    *contents/.github/workflows/docker-keycloak.yml*) cat ${JSON.stringify(join(REPO_ROOT, ".github/workflows/docker-keycloak.yml"))} ;;
    *contents/.github/workflows/web-e2e.yml*) cat ${JSON.stringify(join(REPO_ROOT, ".github/workflows/web-e2e.yml"))} ;;
    *) return 1 ;;
  esac
}
`;
}

async function runHarness(body: string, environment: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "osf-runner-lifecycle-"));
  const harness = join(home, "harness.sh");
  await writeFile(
    harness,
    `#!/bin/bash
set -euo pipefail
source ${JSON.stringify(RUNNERS)}
mkdir -p "$SUPPORT_DIR"

${body}
`,
  );

  try {
    return Bun.spawnSync(["/bin/bash", harness], {
      env: { ...process.env, ...environment, HOME: home },
      timeout: 5_000,
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

function processIsRunning(pid: string) {
  const result = Bun.spawnSync(["/bin/ps", "-p", pid, "-o", "stat="]);
  const state = result.stdout.toString().trim();
  return result.exitCode === 0 && state !== "" && !state.startsWith("Z");
}

function processGroupIsRunning(processGroupId: string) {
  const result = Bun.spawnSync(["/bin/ps", "-axo", "pgid=,stat="]);
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .some((line) => {
      const [pgid, state] = line.trim().split(/\s+/, 2);
      return pgid === processGroupId && state !== "" && !state.startsWith("Z");
    });
}

async function waitForProcessGroupExit(processGroupId: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!processGroupIsRunning(processGroupId)) return true;
    await Bun.sleep(20);
  }
  return !processGroupIsRunning(processGroupId);
}

function processGroupMembers(processGroupId: string) {
  return Bun.spawnSync([
    "/bin/ps",
    "-axo",
    "pid=,ppid=,pgid=,stat=,command=",
  ]).stdout
    .toString()
    .split("\n")
    .filter((line) => {
      const [, , pgid, state] = line.trim().split(/\s+/, 4);
      return pgid === processGroupId && state !== "" && !state.startsWith("Z");
    });
}

async function drainPipeBounded(
  pipe: ReadableStream<Uint8Array>,
  label: string,
) {
  const result = await Promise.race([
    new Response(pipe).text().then((text) => ({ text })),
    Bun.sleep(1_000).then(() => null),
  ]);
  if (result === null) throw new Error(`Timed out draining supervisor ${label}`);
  return result.text;
}

async function cleanupSupervisorTestGroup(home: string) {
  let processGroupId: string;
  try {
    processGroupId = (
      await readFile(join(home, "provision-anchor.pid"), "utf8")
    ).trim();
  } catch {
    return;
  }
  if (!/^\d+$/.test(processGroupId)) {
    throw new Error(`Invalid supervisor test PGID: ${processGroupId}`);
  }
  const members = processGroupMembers(processGroupId);
  if (members.length === 0) return;
  if (!members.some((line) => line.includes(home))) {
    throw new Error(
      `Refusing to terminate unverified supervisor test PGID ${processGroupId}`,
    );
  }
  Bun.spawnSync(["/bin/kill", "-KILL", "--", `-${processGroupId}`]);
  if (!(await waitForProcessGroupExit(processGroupId))) {
    throw new Error(`Supervisor test PGID ${processGroupId} survived cleanup`);
  }
}

function runnerHarnessProcesses() {
  return Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,pgid=,command="])
    .stdout.toString()
    .split("\n")
    .filter((line) =>
      /\/osf-runner-(supervisor-signal|lifecycle)-[^/]+\/(harness|provision-worker|provision-child)\.sh/.test(
        line,
      ),
    );
}

async function waitForRunnerHarnessesExit() {
  const deadline = Date.now() + 1_000;
  let processes = runnerHarnessProcesses();
  while (processes.length > 0 && Date.now() < deadline) {
    await Bun.sleep(20);
    processes = runnerHarnessProcesses();
  }
  return processes;
}

type SupervisorScenario =
  | "normal"
  | "all-ignore"
  | "leader-exits-child-ignores";
type TerminationFailure = "none" | "validation" | "kill-signal";

async function runSupervisorSignal(
  signal: "SIGINT" | "SIGTERM",
  cleanupResult = 0,
  scenario: SupervisorScenario = "normal",
  stallTermination = false,
  terminationFailure: TerminationFailure = "none",
) {
  const home = await mkdtemp(join(tmpdir(), "osf-runner-supervisor-signal-"));
  const harness = join(home, "harness.sh");
  const provisionChild = join(home, "provision-child.sh");
  const provisionReady = join(home, "provision-ready");
  const provisionWorker = join(home, "provision-worker.sh");
  await Promise.all([
    writeFile(
      provisionChild,
      `#!/bin/bash
set -euo pipefail
if (( ${scenario === "normal" ? 0 : 1} )); then
  trap '' TERM
else
  trap 'exit 143' TERM
fi
printf '%s\n' "$$" >"$HOME/provision-child.pid"
touch "$HOME/provision-ready"
while true; do
  /bin/sleep 30 || :
done
`,
    ),
    writeFile(
      provisionWorker,
      `#!/bin/bash
set -euo pipefail
on_term() {
  touch "$HOME/provision-leader-exited-on-term"
  exit 143
}
if (( ${scenario === "all-ignore" ? 1 : 0} )); then
  trap '' TERM
else
  trap on_term TERM
fi
/bin/bash ${JSON.stringify(provisionChild)} &
child_pid=$!
printf '%s\n' "$$" >"$HOME/provision-leader.pid"
process_group_id="$(ps -p "$$" -o pgid=)"
process_group_id="\${process_group_id//[[:space:]]/}"
printf '%s\n' "$process_group_id" >"$HOME/provision-anchor.pid"
wait "$child_pid"
`,
    ),
    writeFile(
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
${
  stallTermination
    ? "terminate_active_provision() { /bin/sleep 30; }"
    : terminationFailure === "validation"
      ? `provision_anchor_is_direct_child() {
  if [[ "\${SUPERVISOR_PROVISION_STATE:-}" == terminating &&
    ! -e "$HOME/validation-failure-injected" ]]; then
    if [[ ! "\${SUPERVISOR_PROVISION_PID:-}" =~ ^[0-9]+$ ||
      -z "\${SUPERVISOR_PROVISION_READY_FILE:-}" ||
      -z "\${SUPERVISOR_PROVISION_RESULT_FILE:-}" ]]; then
      echo 'validation failure did not retain provision identity' >&2
      return 98
    fi
    printf '%s|%s|%s\n' "$SUPERVISOR_PROVISION_PID" \
      "$SUPERVISOR_PROVISION_READY_FILE" "$SUPERVISOR_PROVISION_RESULT_FILE" \
      >"$HOME/failure-identity-retained"
    touch "$HOME/validation-failure-injected"
    return 1
  fi
  local provision_pid="$1"
  local process_group_id
  provision_pid_is_direct_child "$provision_pid" || return 1
  process_group_id="$(ps -p "$provision_pid" -o pgid= 2>/dev/null)" || return 1
  process_group_id="\${process_group_id//[[:space:]]/}"
  [[ "$process_group_id" == "$provision_pid" ]]
}`
      : terminationFailure === "kill-signal"
        ? `kill() {
  if [[ "\${1:-}" == -KILL && "\${2:-}" == -- &&
    ! -e "$HOME/kill-failure-injected" ]]; then
    if [[ ! "\${SUPERVISOR_PROVISION_PID:-}" =~ ^[0-9]+$ ||
      -z "\${SUPERVISOR_PROVISION_READY_FILE:-}" ||
      -z "\${SUPERVISOR_PROVISION_RESULT_FILE:-}" ]]; then
      echo 'KILL failure did not retain provision identity' >&2
      return 98
    fi
    printf '%s|%s|%s\n' "$SUPERVISOR_PROVISION_PID" \
      "$SUPERVISOR_PROVISION_READY_FILE" "$SUPERVISOR_PROVISION_RESULT_FILE" \
      >"$HOME/failure-identity-retained"
    touch "$HOME/kill-failure-injected"
    return 77
  fi
  builtin kill "$@"
}`
        : ""
}
provision_slot() {
  /bin/bash ${JSON.stringify(provisionWorker)}
}
supervise_slot 1
`,
    ),
  ]);

  const subprocess = Bun.spawn(["/bin/bash", harness], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await waitForFile(provisionReady);
    await waitForFile(join(home, "provision-anchor.pid"));
    const provisionAnchorPidBeforeSignal = (
      await readFile(join(home, "provision-anchor.pid"), "utf8")
    ).trim();
    const provisionGroupBeforeSignal = Bun.spawnSync([
      "/bin/ps",
      "-p",
      provisionAnchorPidBeforeSignal,
      "-o",
      "pgid=",
    ]).stdout.toString().trim();
    if (provisionGroupBeforeSignal !== provisionAnchorPidBeforeSignal) {
      throw new Error(
        `Provision anchor ${provisionAnchorPidBeforeSignal} did not own PGID ${provisionGroupBeforeSignal}`,
      );
    }
    subprocess.kill(signal);
    const exitCode = await Promise.race([
      subprocess.exited,
      Bun.sleep(3_000).then(() => null),
    ]);
    if (exitCode === null) {
      await cleanupSupervisorTestGroup(home);
      subprocess.kill("SIGKILL");
      const killed = await Promise.race([
        subprocess.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]);
      if (!killed) throw new Error("Supervisor survived SIGKILL after timeout");
      throw new Error(`Supervisor did not exit after ${signal}`);
    }
    // Descendants inherit the harness pipes. Bound exact-group cleanup before
    // starting either independently bounded drain so a leak cannot deadlock
    // this helper or prevent its final cleanup.
    await cleanupSupervisorTestGroup(home);
    const [
      stdout,
      stderr,
      cleanupLifecycle,
      provisionAnchorPid,
      provisionChildPid,
      provisionLeaderPid,
      failureIdentityRetained,
    ] = await Promise.all([
        drainPipeBounded(subprocess.stdout, "stdout"),
        drainPipeBounded(subprocess.stderr, "stderr"),
        readFile(join(home, "cleanup-lifecycle"), "utf8"),
        readFile(join(home, "provision-anchor.pid"), "utf8"),
        readFile(join(home, "provision-child.pid"), "utf8"),
        readFile(join(home, "provision-leader.pid"), "utf8"),
        readFile(join(home, "failure-identity-retained"), "utf8").catch(
          () => "",
        ),
      ]);
    const provisionGroupExited = await waitForProcessGroupExit(
      provisionAnchorPid.trim(),
    );
    const provisionLeaderExitedOnTerm = await access(
      join(home, "provision-leader-exited-on-term"),
    )
      .then(() => true)
      .catch(() => false);
    return {
      cleanupLifecycle,
      exitCode,
      failureIdentityRetained: failureIdentityRetained.trim(),
      provisionAnchorPid: provisionAnchorPid.trim(),
      provisionGroupBeforeSignal,
      provisionAnchorAlive: processIsRunning(provisionAnchorPid.trim()),
      provisionChildPid: provisionChildPid.trim(),
      provisionChildAlive: processIsRunning(provisionChildPid.trim()),
      provisionGroupAlive: !provisionGroupExited,
      provisionLeaderPid: provisionLeaderPid.trim(),
      provisionLeaderAlive: processIsRunning(provisionLeaderPid.trim()),
      provisionLeaderExitedOnTerm,
      stderr,
      stdout,
    };
  } finally {
    await cleanupSupervisorTestGroup(home);
    if (subprocess.exitCode === null) {
      subprocess.kill("SIGKILL");
      const killed = await Promise.race([
        subprocess.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]);
      if (!killed) throw new Error("Supervisor survived final SIGKILL cleanup");
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

describe("host workflow authorization", () => {
  test("authorizes independently verified head, base, and merge workflow revisions", async () => {
    const result = await runHarness(`
${hostAuthorizationApi()}
expected="${WORKFLOW_SHA}"$'\\n'"${BASE_WORKFLOW_SHA}"$'\\n'"${MERGE_WORKFLOW_SHA}"
[[ "$(authorize_active_workflow_shas)" == "$expected" ]]
grep -Fq -- '--hostname github.com --paginate --slurp' "$HOME/gh-calls"
grep -Fq -- 'Accept: application/vnd.github+json' "$HOME/gh-calls"
grep -Fq -- 'Accept: application/vnd.github.raw+json' "$HOME/gh-calls"
grep -Fq -- 'X-GitHub-Api-Version: 2022-11-28' "$HOME/gh-calls"
[[ "$(grep -c 'actions/runs?event=pull_request' "$HOME/gh-calls")" == 1 ]]
! grep -Fq 'status=' "$HOME/gh-calls"
[[ "$(grep -c 'actions/runs/${WORKFLOW_RUN_ID}/attempts/1' "$HOME/gh-calls")" == 1 ]]
[[ "$(grep -c 'pulls/${PULL_REQUEST_NUMBER}' "$HOME/gh-calls")" == 1 ]]
[[ "$(grep -c 'contents/.github/workflows/' "$HOME/gh-calls")" == 12 ]]
[[ "$(grep -c 'ref=${WORKFLOW_SHA}' "$HOME/gh-calls")" == 4 ]]
[[ "$(grep -c 'ref=${BASE_WORKFLOW_SHA}' "$HOME/gh-calls")" == 4 ]]
[[ "$(grep -c 'ref=${MERGE_WORKFLOW_SHA}' "$HOME/gh-calls")" == 4 ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("keeps candidate SHAs while sibling jobs remain in an active workflow run", async () => {
    const result = await runHarness(`
${hostAuthorizationApi({ activeStatus: "in_progress" })}
expected="${WORKFLOW_SHA}"$'\\n'"${BASE_WORKFLOW_SHA}"$'\\n'"${MERGE_WORKFLOW_SHA}"
[[ "$(authorize_active_workflow_shas)" == "$expected" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
  });

  test("fails closed when the active snapshot has no same-repository candidate", async () => {
    const forkRun = {
      ...workflowRun(),
      head_repository: { full_name: "contributor/OpenShapeForge" },
    };
    const result = await runHarness(`
${hostAuthorizationApi({ pages: [{ total_count: 1, workflow_runs: [forkRun] }] })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "No active same-repository pull-request workflow run is available",
    );
  });

  for (const [label, malformedRun] of [
    ["malformed", { ...workflowRun(), pull_requests: "invalid" }],
    [
      "multiple",
      {
        ...workflowRun(),
        pull_requests: [
          ...workflowRun().pull_requests,
          {
            number: PULL_REQUEST_NUMBER + 1,
            head: { sha: WORKFLOW_SHA },
            base: { sha: BASE_WORKFLOW_SHA },
          },
        ],
      },
    ],
    ["mismatched", { ...workflowRun(), head_sha: STALE_WORKFLOW_SHA }],
  ] as const) {
    test(`fails closed on ${label} pull-request run metadata`, async () => {
      const result = await runHarness(`
${hostAuthorizationApi({ pages: [{ total_count: 1, workflow_runs: [malformedRun] }] })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

      expect(result.exitCode, output(result)).toBe(0);
      expect(result.stderr.toString()).toContain(
        "Pull-request workflow-run response was incomplete or malformed",
      );
    });
  }

  test("fails the complete snapshot when any active same-repository run is malformed", async () => {
    const malformedSibling = {
      ...workflowRun(),
      id: WORKFLOW_RUN_ID + 1,
      pull_requests: [],
    };
    const result = await runHarness(`
${hostAuthorizationApi({
  pages: [
    {
      total_count: 2,
      workflow_runs: [workflowRun(), malformedSibling],
    },
  ],
})}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
[[ "$(grep -c '/attempts/' "$HOME/gh-calls" || true)" == 0 ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Pull-request workflow-run response was incomplete or malformed",
    );
  });

  test("rejects runs that reference reusable workflows", async () => {
    const reusableRun = {
      ...verifiedWorkflowRun(),
      referenced_workflows: [
        {
          path: "OpenShapeForge/OpenShapeForge/.github/workflows/reuse.yml@main",
          sha: WORKFLOW_SHA,
          ref: "refs/heads/main",
        },
      ],
    };
    const result = await runHarness(`
${hostAuthorizationApi({ verifiedRun: reusableRun })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
[[ "$(grep -c 'pulls/${PULL_REQUEST_NUMBER}' "$HOME/gh-calls" || true)" == 0 ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "metadata was malformed, stale, or reusable",
    );
  });

  test("rejects a pull request that changed after the fixed run snapshot", async () => {
    const stalePullRequest = {
      ...currentPullRequest(),
      head: {
        ...currentPullRequest().head,
        sha: STALE_WORKFLOW_SHA,
      },
    };
    const result = await runHarness(`
${hostAuthorizationApi({ pullRequest: stalePullRequest })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
[[ "$(grep -c 'contents/' "$HOME/gh-calls" || true)" == 0 ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "no longer matches its workflow run",
    );
  });

  for (const [label, mergeCommitSha] of [
    ["missing", null],
    ["malformed", "not-a-sha"],
  ] as const) {
    test(`rejects a ${label} current merge commit SHA`, async () => {
      const result = await runHarness(`
${hostAuthorizationApi({ pullRequest: currentPullRequest(mergeCommitSha) })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

      expect(result.exitCode, output(result)).toBe(0);
      expect(result.stderr.toString()).toContain(
        "no longer matches its workflow run",
      );
    });
  }

  test("fails closed when paginated active-run enumeration fails", async () => {
    const result = await runHarness(`
${hostAuthorizationApi({ failAt: "enumeration" })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
[[ "$(grep -c 'contents/' "$HOME/gh-calls" || true)" == 0 ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not enumerate all pull-request workflow runs",
    );
  });

  test("fails closed when pagination is incomplete", async () => {
    const result = await runHarness(`
${hostAuthorizationApi({
  pages: [{ total_count: 2, workflow_runs: [workflowRun()] }],
})}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Pull-request workflow-run response was incomplete or malformed",
    );
  });

  for (const [stage, message] of [
    ["run", "Could not verify active workflow run"],
    ["pull", "Could not verify pull request"],
  ] as const) {
    test(`fails closed when the ${stage} API fails`, async () => {
      const result = await runHarness(`
${hostAuthorizationApi({ failAt: stage })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

      expect(result.exitCode, output(result)).toBe(0);
      expect(result.stderr.toString()).toContain(message);
    });
  }

  test("fails closed when authenticated workflow content cannot be fetched", async () => {
    const result = await runHarness(`
${hostAuthorizationApi({ failAt: "content" })}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not fetch approved workflow .github/workflows/ci.yml",
    );
  });

  test("fails closed when the workflow hash result is malformed", async () => {
    const result = await runHarness(`
${hostAuthorizationApi()}
shasum() {
  command cat >/dev/null
  printf 'not-a-digest  -\\n'
}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "Could not hash approved workflow .github/workflows/ci.yml",
    );
  });

  test("fails closed when every candidate has different routed workflow bytes", async () => {
    const result = await runHarness(`
${hostAuthorizationApi({
  modifiedWorkflowRefs: [
    WORKFLOW_SHA,
    BASE_WORKFLOW_SHA,
    MERGE_WORKFLOW_SHA,
  ],
})}
set +e
authorize_active_workflow_shas
authorize_result=$?
set -e
(( authorize_result != 0 ))
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      "No active workflow revision matches the reviewed routed workflow content",
    );
  });

  test("includes only candidate revisions with exact reviewed workflow digests", async () => {
    const result = await runHarness(`
${hostAuthorizationApi({ modifiedWorkflowRefs: [BASE_WORKFLOW_SHA] })}
expected="${WORKFLOW_SHA}"$'\\n'"${MERGE_WORKFLOW_SHA}"
[[ "$(authorize_active_workflow_shas)" == "$expected" ]]
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stderr.toString()).toContain(
      `Workflow revision ${BASE_WORKFLOW_SHA} differs from reviewed routed workflow content`,
    );
  });

  test("pins controller digests to every current routed workflow file", async () => {
    const result = await runHarness("print_approved_workflow_sha256");
    expect(result.exitCode, output(result)).toBe(0);
    const approved = result.stdout.toString().trim().split("\n");
    expect(approved).toHaveLength(4);
    expect(approved.map((record) => record.split(" ")[0])).toEqual([
      ...new Set(
        APPROVED_SELF_HOSTED_ROUTES.map((route) => route.split("#")[0]),
      ),
    ]);
    for (const record of approved) {
      const [workflowPath, expectedSha256] = record.split(" ");
      const source = await readFile(join(REPO_ROOT, workflowPath));
      const actualSha256 = new Bun.CryptoHasher("sha256")
        .update(source)
        .digest("hex");
      expect(expectedSha256, workflowPath).toBe(actualSha256);
    }
  });

  test("installs only validated SHAs as a root-owned world-readable guest allow-list", async () => {
    const result = await runHarness(`
colima() {
  printf '%s\n' "$*" >"$HOME/colima-command"
  cat >"$HOME/guest-input"
}
install_pre_job_policy profile "${WORKFLOW_SHA}"
[[ "$(cat "$HOME/guest-input")" == "${WORKFLOW_SHA}" ]]
grep -Fq 'sudo chown root:root /opt/openshapeforge-runner/approved-workflow-shas' "$HOME/colima-command"
grep -Fq 'sudo chmod 0444 /opt/openshapeforge-runner/approved-workflow-shas' "$HOME/colima-command"
set +e
install_pre_job_policy profile 'not-a-sha'
invalid_result=$?
set -e
(( invalid_result != 0 ))
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
    expect(preStartHardening).toBeGreaterThan(serviceInstall);
    expect(isolationVerification).toBeGreaterThan(preStartHardening);
    expect(preJobVerification).toBeGreaterThan(isolationVerification);
    expect(labelAdmission).toBeGreaterThan(preJobVerification);
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

  test("snapshots workflows after isolation and immediately before routing admission", async () => {
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
    const isolationProof = provision.indexOf(
      'verify_unprivileged_runner "$profile" "$service"',
    );
    const workflowSnapshot = provision.indexOf(
      'approved_workflow_shas="$(authorize_active_workflow_shas)"',
    );
    const policyInstall = provision.indexOf(
      'install_pre_job_policy "$profile" "$approved_workflow_shas"',
    );
    const policyProof = provision.indexOf(
      'verify_pre_job_policy "$profile" "$service"',
    );
    const routingAdmission = provision.indexOf(
      'add_repository_runner_routing_label "$runner_id"',
    );
    const listenerStart = provision.indexOf(
      'start_runner_service "$profile" "$service"',
    );

    expect(provisionStart).toBeGreaterThanOrEqual(0);
    expect(provisionEnd).toBeGreaterThan(provisionStart);
    expect(forwardingFlag).toBeGreaterThanOrEqual(0);
    expect(loopbackHardening).toBeGreaterThan(forwardingFlag);
    expect(liveProof).toBeGreaterThan(loopbackHardening);
    expect(tokenRequest).toBeGreaterThan(liveProof);
    expect(isolationProof).toBeGreaterThan(tokenRequest);
    expect(workflowSnapshot).toBeGreaterThan(isolationProof);
    expect(policyInstall).toBeGreaterThan(workflowSnapshot);
    expect(policyProof).toBeGreaterThan(policyInstall);
    expect(routingAdmission).toBeGreaterThan(policyProof);
    expect(listenerStart).toBeGreaterThan(routingAdmission);
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

  test("keeps a completed anchor alive until its result is released", async () => {
    const result = await runHarness(`
provision_slot() { return 7; }
launch_active_provision 1
anchor_pid="$SUPERVISOR_PROVISION_PID"
for attempt in {1..100}; do
  [[ -s "$SUPERVISOR_PROVISION_RESULT_FILE" ]] && break
  /bin/sleep 0.01
done
if [[ "$(<"$SUPERVISOR_PROVISION_RESULT_FILE")" != 7 ]]; then
  echo 'completed worker result was not reported' >&2
  exit 91
fi
if ! provision_anchor_is_active "$anchor_pid"; then
  echo 'anchor exited before parent release' >&2
  exit 92
fi
printf 'anchor-held-after-result\\n'
set +e
wait_for_active_provision_result
provision_result=$?
set -e
if (( provision_result != 7 )); then
  echo "unexpected provision result $provision_result" >&2
  exit 93
fi
if /bin/kill -0 "$anchor_pid" 2>/dev/null; then
  echo 'anchor survived parent release' >&2
  exit 94
fi
printf 'anchor-released-and-reaped\\n'
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stdout.toString()).toBe(
      "anchor-held-after-result\nanchor-released-and-reaped\n",
    );
  });

  test("bounds a stuck anchor release and terminates its exact group", async () => {
    const startedAt = Date.now();
    const result = await runHarness(`
run_active_provision_anchor() {
  local ready_file="$2"
  local result_file="$3"
  trap - EXIT
  trap '' INT TERM USR1
  printf 'ready\\n' >"$ready_file"
  printf '0\\n' >"$result_file"
  while true; do :; done
}
launch_active_provision 1
anchor_pid="$SUPERVISOR_PROVISION_PID"
set +e
wait_for_active_provision_result
provision_result=$?
set -e
if (( provision_result == 0 )); then
  echo 'stuck anchor release unexpectedly succeeded' >&2
  exit 91
fi
if [[ -n "$SUPERVISOR_PROVISION_PID" ]]; then
  echo 'stuck anchor identity remained after confirmed fallback cleanup' >&2
  exit 92
fi
if /bin/kill -0 "$anchor_pid" 2>/dev/null; then
  echo 'stuck anchor survived release fallback' >&2
  exit 93
fi
printf 'stuck-anchor-fallback-reaped\\n'
`);

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stdout.toString()).toBe("stuck-anchor-fallback-reaped\n");
    expect(result.stderr.toString()).toContain("missed its release deadline");
    expect(result.stderr.toString()).toContain(
      "reached the TERM deadline; forcing termination",
    );
  });

  test("does not signal or await an unrelated replacement identity", async () => {
    const result = await runHarness(`
(
  trap 'touch "$HOME/replacement-signaled"; exit 99' INT TERM
  touch "$HOME/replacement-ready"
  while true; do
    /bin/sleep 30 || :
  done
) &
replacement_pid=$!
while [[ ! -e "$HOME/replacement-ready" ]]; do
  /bin/sleep 0.01
done
SUPERVISOR_PROVISION_PID="$replacement_pid"
SUPERVISOR_PROVISION_STATE="active"
set +e
terminate_active_provision
terminate_result=$?
set -e
if (( terminate_result == 0 )); then
  echo 'replacement identity unexpectedly validated as an anchor' >&2
  exit 91
fi
if ! /bin/kill -0 "$replacement_pid" 2>/dev/null; then
  echo 'replacement sentinel was not alive after validation failure' >&2
  exit 92
fi
if [[ -e "$HOME/replacement-signaled" ]]; then
  echo 'replacement sentinel received a supervisor signal' >&2
  exit 93
fi
printf 'replacement-alive-unsignalled\\n'
/bin/kill -KILL "$replacement_pid" || exit 94
builtin wait "$replacement_pid" 2>/dev/null || :
if /bin/kill -0 "$replacement_pid" 2>/dev/null; then
  echo 'replacement sentinel survived explicit test cleanup' >&2
  exit 95
fi
printf 'replacement-reaped\\n'
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stdout.toString()).toBe(
      "replacement-alive-unsignalled\nreplacement-reaped\n",
    );
    expect(result.stderr.toString()).not.toContain("unbound variable");
  });

  test("defers a pre-publication signal until provisioning identity is safe", async () => {
    const result = await runHarness(`
require_host_tools() { :; }
require_host_isolation() { :; }
ensure_runner_archive() { :; }
provision_slot() {
  /bin/sleep 30 &
  printf '%s\\n' "$!" >"$HOME/prepublication-child.pid"
  wait "$!"
}
cleanup_slot_serialized() {
  anchor_pid="$(<"$HOME/prepublication-anchor.pid")"
  if /bin/kill -0 "$anchor_pid" 2>/dev/null; then
    echo 'pre-publication anchor survived termination' >&2
    return 90
  fi
  printf 'prepublication-anchor-dead\\n'
  if [[ -e "$HOME/prepublication-child.pid" ]]; then
    child_pid="$(<"$HOME/prepublication-child.pid")"
    if /bin/kill -0 "$child_pid" 2>/dev/null; then
      echo 'pre-publication provision child survived termination' >&2
      return 91
    fi
    printf 'prepublication-child-dead\\n'
  fi
  printf 'cleanup:%s\\n' "$1"
}
set -T
trap '
  if [[ "$SUPERVISOR_PROVISION_STATE" == launching &&
    -z "$SUPERVISOR_PROVISION_PID" && "\${provision_pid:-}" =~ ^[0-9]+$ &&
    -s "$SUPERVISOR_PROVISION_READY_FILE" ]]; then
    trap - DEBUG
    printf "%s\\n" "$provision_pid" >"$HOME/prepublication-anchor.pid"
    supervisor_signal_received 143
    if [[ "$SUPERVISOR_PROVISION_STATE" != launching ]]; then
      echo "pre-publication signal was not deferred during launch" >&2
      exit 92
    fi
    if [[ "$SUPERVISOR_PENDING_SIGNAL_STATUS" != 143 ]]; then
      echo "pre-publication signal status was not retained" >&2
      exit 93
    fi
  fi
' DEBUG
supervise_slot 1
`);

    expect(result.exitCode, output(result)).toBe(143);
    expect(result.stdout.toString()).toContain("prepublication-anchor-dead\n");
    expect(result.stdout.toString()).toContain("cleanup:1\n");
    expect(result.stderr.toString()).not.toContain("unbound variable");
  });

  test("kills an unpublished anchor when handshake validation fails", async () => {
    const result = await runHarness(`
provision_slot() {
  while true; do
    /bin/sleep 30 || :
  done
}
provision_anchor_is_active() { return 1; }
set +e
launch_active_provision 1
launch_result=$?
set -e
if (( launch_result == 0 )); then
  echo 'invalid anchor handshake unexpectedly succeeded' >&2
  exit 91
fi
if [[ -n "$SUPERVISOR_PROVISION_PID" ]]; then
  echo 'failed handshake published an anchor identity' >&2
  exit 92
fi
printf 'handshake-anchor-discarded\\n'
`);

    expect(result.exitCode, output(result)).toBe(0);
    expect(result.stdout.toString()).toBe("handshake-anchor-discarded\n");
    expect(result.stderr.toString()).toContain(
      "failed before publishing a stable identity",
    );
  });

  test("reaps the exact provision group when an async harness times out", async () => {
    await expect(
      runSupervisorSignal("SIGTERM", 0, "all-ignore", true),
    ).rejects.toThrow("Supervisor did not exit after SIGTERM");
    expect(runnerHarnessProcesses()).toEqual([]);
  });

  test("kills the published group when anchor validation fails", async () => {
    const result = await runSupervisorSignal(
      "SIGTERM",
      0,
      "leader-exits-child-ignores",
      false,
      "validation",
    );
    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(143);
    expect(result.provisionAnchorAlive).toBe(false);
    expect(result.provisionLeaderAlive).toBe(false);
    expect(result.provisionChildAlive).toBe(false);
    expect(result.provisionGroupAlive).toBe(false);
    expect(result.failureIdentityRetained.split("|", 1)[0]).toBe(
      result.provisionAnchorPid,
    );
    expect(result.failureIdentityRetained.split("|")).toHaveLength(3);
    expect(result.cleanupLifecycle).toBe(
      "release\nacquire\ncleanup:1\nrelease\n",
    );
    expect(result.stderr).toContain(
      "Could not validate active provisioning anchor",
    );
    expect(result.stderr).toContain(
      "Active provisioning termination failed with status 1",
    );
  });

  test("preserves signal status across termination and cleanup failures", async () => {
    const result = await runSupervisorSignal(
      "SIGINT",
      9,
      "all-ignore",
      false,
      "kill-signal",
    );
    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(130);
    expect(result.provisionAnchorAlive).toBe(false);
    expect(result.provisionLeaderAlive).toBe(false);
    expect(result.provisionChildAlive).toBe(false);
    expect(result.provisionGroupAlive).toBe(false);
    expect(result.failureIdentityRetained.split("|", 1)[0]).toBe(
      result.provisionAnchorPid,
    );
    expect(result.failureIdentityRetained.split("|")).toHaveLength(3);
    expect(result.cleanupLifecycle).toBe(
      "release\nacquire\ncleanup:1\nrelease\n",
    );
    expect(result.stderr).toContain(
      "Active provisioning termination failed with status 1",
    );
    expect(result.stderr).toContain(
      "Supervisor cleanup for slot 1 failed with status 9",
    );
  });

  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`${signal} terminates active provisioning before serialized cleanup`, async () => {
      const result = await runSupervisorSignal(signal);
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(exitCode);
      expect(result.provisionAnchorPid).not.toBe(result.provisionLeaderPid);
      expect(result.provisionGroupBeforeSignal).toBe(result.provisionAnchorPid);
      expect(result.provisionLeaderPid).not.toBe(result.provisionChildPid);
      expect(result.provisionAnchorAlive).toBe(false);
      expect(result.provisionLeaderAlive).toBe(false);
      expect(result.provisionChildAlive).toBe(false);
      expect(result.provisionGroupAlive).toBe(false);
      expect(result.cleanupLifecycle).toBe(
        "release\nacquire\ncleanup:1\nrelease\n",
      );
      expect(result.stderr).not.toContain("unbound variable");
    });

    test(`${signal} force kills TERM-ignoring provisioning before cleanup`, async () => {
      const startedAt = Date.now();
      const result = await runSupervisorSignal(signal, 0, "all-ignore");
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(exitCode);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(result.provisionAnchorPid).not.toBe(result.provisionLeaderPid);
      expect(result.provisionGroupBeforeSignal).toBe(result.provisionAnchorPid);
      expect(result.provisionLeaderPid).not.toBe(result.provisionChildPid);
      expect(result.provisionAnchorAlive).toBe(false);
      expect(result.provisionLeaderAlive).toBe(false);
      expect(result.provisionChildAlive).toBe(false);
      expect(result.provisionGroupAlive).toBe(false);
      expect(result.cleanupLifecycle).toBe(
        "release\nacquire\ncleanup:1\nrelease\n",
      );
      expect(result.stderr).toContain(
        "reached the TERM deadline; forcing termination",
      );
      expect(result.stderr).not.toContain("unbound variable");
    });

    test(`${signal} kills an ignoring child after its leader exits on TERM`, async () => {
      const result = await runSupervisorSignal(
        signal,
        0,
        "leader-exits-child-ignores",
      );
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(exitCode);
      expect(result.provisionLeaderExitedOnTerm).toBe(true);
      expect(result.provisionGroupBeforeSignal).toBe(result.provisionAnchorPid);
      expect(result.provisionAnchorAlive).toBe(false);
      expect(result.provisionLeaderAlive).toBe(false);
      expect(result.provisionChildAlive).toBe(false);
      expect(result.provisionGroupAlive).toBe(false);
      expect(result.cleanupLifecycle).toBe(
        "release\nacquire\ncleanup:1\nrelease\n",
      );
      expect(result.stderr).toContain(
        "reached the TERM deadline; forcing termination",
      );
    });

    test(`${signal} preserves its exit status when cleanup fails`, async () => {
      const result = await runSupervisorSignal(signal, 9);
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(exitCode);
      expect(result.provisionGroupBeforeSignal).toBe(result.provisionAnchorPid);
      expect(result.provisionAnchorAlive).toBe(false);
      expect(result.provisionLeaderAlive).toBe(false);
      expect(result.provisionChildAlive).toBe(false);
      expect(result.provisionGroupAlive).toBe(false);
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

  test("leaves no runner lifecycle harness processes", async () => {
    expect(await waitForRunnerHarnessesExit()).toEqual([]);
  });
});
