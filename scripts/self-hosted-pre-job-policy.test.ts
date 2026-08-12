// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APPROVED_SELF_HOSTED_ROUTES } from "./check-self-hosted-routing.mjs";

const POLICY = join(import.meta.dir, "self-hosted-pre-job-policy.sh");
const REPOSITORY = "OpenShapeForge/OpenShapeForge";
const WORKFLOW_SHA = "0123456789abcdef0123456789abcdef01234567";
const VERIFIED_MERGE_WORKFLOW_SHA =
  "2222222222222222222222222222222222222222";
const UNKNOWN_WORKFLOW_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const ALLOW_LIST_DECLARATION =
  'readonly APPROVED_WORKFLOW_SHAS_FILE="/opt/openshapeforge-runner/approved-workflow-shas"';
let fixtures: string;

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "osf-pre-job-policy-"));
});

afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});

async function runPolicy({
  eventName = "pull_request",
  repository = REPOSITORY,
  headRepository = REPOSITORY,
  baseRepository = REPOSITORY,
  fork = false,
  includeEvent = true,
  workflowPath = ".github/workflows/ci.yml",
  workflowRevision = "refs/pull/383/merge",
  workflowSha = WORKFLOW_SHA,
  workflowName = "CI",
  job = "gates",
  approvedWorkflowShas = [WORKFLOW_SHA],
} = {}) {
  const eventPath = join(fixtures, `${crypto.randomUUID()}.json`);
  const allowListPath = join(fixtures, `${crypto.randomUUID()}.allow-list`);
  const policyPath = join(fixtures, `${crypto.randomUUID()}.sh`);
  if (includeEvent) {
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { full_name: repository },
        pull_request: {
          base: { repo: { full_name: baseRepository } },
          head: { repo: { full_name: headRepository, fork } },
        },
      }),
    );
  }
  await writeFile(
    allowListPath,
    approvedWorkflowShas.length === 0
      ? ""
      : `${approvedWorkflowShas.join("\n")}\n`,
  );
  const policySource = await readFile(POLICY, "utf8");
  const testPolicySource = policySource.replace(
    ALLOW_LIST_DECLARATION,
    `readonly APPROVED_WORKFLOW_SHAS_FILE=${JSON.stringify(allowListPath)}`,
  );
  expect(testPolicySource).not.toBe(policySource);
  await writeFile(policyPath, testPolicySource);

  return Bun.spawnSync(["bash", policyPath], {
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_JOB: job,
      GITHUB_REPOSITORY: repository,
      GITHUB_WORKFLOW: workflowName,
      GITHUB_WORKFLOW_REF:
        workflowPath === ""
          ? ""
          : `${REPOSITORY}/${workflowPath}@${workflowRevision}`,
      GITHUB_WORKFLOW_SHA: workflowSha,
    },
  });
}

describe("self-hosted pre-job policy", () => {
  test("uses exactly the routes approved by the static workflow audit", async () => {
    const listed = Bun.spawnSync(["bash", POLICY, "--print-approved-routes"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString().trim().split("\n")).toEqual(
      APPROVED_SELF_HOSTED_ROUTES,
    );

    for (const route of APPROVED_SELF_HOSTED_ROUTES) {
      const [workflowPath, job] = route.split("#");
      expect(
        (await runPolicy({ workflowPath, job })).exitCode,
        route,
      ).toBe(0);
    }
  });

  test("uses only the fixed host-installed workflow SHA allow-list", async () => {
    const source = await readFile(POLICY, "utf8");
    expect(source).toContain(ALLOW_LIST_DECLARATION);
    expect(source).not.toContain("curl");
    expect(source).not.toContain("raw.githubusercontent.com");
    expect(source).not.toContain("GITHUB_TOKEN");
    expect(source).not.toContain("GH_TOKEN");
    expect(source).not.toContain("approved_workflow_sha256");
  });

  test("accepts exact membership anywhere in a strict SHA allow-list", async () => {
    const result = await runPolicy({
      approvedWorkflowShas: [UNKNOWN_WORKFLOW_SHA, WORKFLOW_SHA],
    });
    expect(result.exitCode).toBe(0);
  });

  test("accepts a verified merge workflow SHA that differs from the REST run head", async () => {
    const result = await runPolicy({
      workflowSha: VERIFIED_MERGE_WORKFLOW_SHA,
      approvedWorkflowShas: [WORKFLOW_SHA, VERIFIED_MERGE_WORKFLOW_SHA],
    });
    expect(VERIFIED_MERGE_WORKFLOW_SHA).not.toBe(WORKFLOW_SHA);
    expect(result.exitCode).toBe(0);
  });

  test("does not depend on the mutable workflow display name", async () => {
    expect((await runPolicy({ workflowName: "Renamed by the PR" })).exitCode).toBe(0);
  });

  test("rejects caller and reusable-callee identity confusion at an unknown SHA", async () => {
    const result = await runPolicy({
      workflowPath: ".github/workflows/ci.yml",
      job: "gates",
      workflowSha: UNKNOWN_WORKFLOW_SHA,
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("rejects a workflow SHA added after the host queue snapshot", async () => {
    expect(
      (await runPolicy({ workflowSha: UNKNOWN_WORKFLOW_SHA })).exitCode,
    ).not.toBe(0);
  });

  test("rejects an empty or malformed host allow-list", async () => {
    expect(
      (await runPolicy({ approvedWorkflowShas: [] })).exitCode,
    ).not.toBe(0);
    expect(
      (
        await runPolicy({
          approvedWorkflowShas: [WORKFLOW_SHA, "not-a-workflow-sha"],
        })
      ).exitCode,
    ).not.toBe(0);
  });

  test("rejects group-only and mixed routes added to an approved workflow", async () => {
    expect((await runPolicy({ job: "group-only" })).exitCode).not.toBe(0);
    expect((await runPolicy({ job: "mixed-route" })).exitCode).not.toBe(0);
  });

  test("rejects a renamed approved job", async () => {
    expect((await runPolicy({ job: "renamed-gates" })).exitCode).not.toBe(0);
  });

  test("rejects an unapproved or renamed workflow", async () => {
    expect(
      (await runPolicy({ workflowPath: ".github/workflows/unapproved.yml" }))
        .exitCode,
    ).not.toBe(0);
    expect(
      (await runPolicy({ workflowPath: ".github/workflows/renamed-ci.yml" }))
        .exitCode,
    ).not.toBe(0);
  });

  test("rejects missing workflow or job identity", async () => {
    expect((await runPolicy({ workflowPath: "" })).exitCode).not.toBe(0);
    expect((await runPolicy({ job: "" })).exitCode).not.toBe(0);
  });

  test("rejects a workflow identity without a revision", async () => {
    expect((await runPolicy({ workflowRevision: "" })).exitCode).not.toBe(0);
  });

  test("rejects malformed workflow SHA and path values", async () => {
    expect((await runPolicy({ workflowSha: "abc123" })).exitCode).not.toBe(0);
    expect(
      (await runPolicy({ workflowSha: `${WORKFLOW_SHA.slice(0, 39)}g` })).exitCode,
    ).not.toBe(0);
    expect(
      (
        await runPolicy({
          workflowPath: ".github/workflows/../workflows/ci.yml",
        })
      ).exitCode,
    ).not.toBe(0);
  });

  test("rejects a fork pull request", async () => {
    expect(
      (await runPolicy({ headRepository: "contributor/OpenShapeForge", fork: true }))
        .exitCode,
    ).not.toBe(0);
  });

  test("rejects pull_request_target before workflow steps", async () => {
    expect((await runPolicy({ eventName: "pull_request_target" })).exitCode).not.toBe(0);
  });

  test("rejects a different base repository", async () => {
    expect(
      (await runPolicy({ baseRepository: "other/OpenShapeForge" })).exitCode,
    ).not.toBe(0);
  });

  test("rejects a missing event payload", async () => {
    expect((await runPolicy({ includeEvent: false })).exitCode).not.toBe(0);
  });
});
