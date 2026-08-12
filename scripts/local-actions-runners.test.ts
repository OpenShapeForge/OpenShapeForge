// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNERS = join(import.meta.dir, "local-actions-runners.sh");
const PRE_JOB_POLICY = join(import.meta.dir, "self-hosted-pre-job-policy.sh");

async function runHarness(body: string) {
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
      env: { ...process.env, HOME: home },
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

  test("cleanup still refuses to delete a busy runner", async () => {
    const result = await runHarness(`
gh() { printf 'runner-busy\\n'; }
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
});
