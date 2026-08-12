// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const POLICY = join(import.meta.dir, "self-hosted-pre-job-policy.sh");
const REPOSITORY = "OpenShapeForge/OpenShapeForge";
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
} = {}) {
  const eventPath = join(fixtures, `${crypto.randomUUID()}.json`);
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
  return Bun.spawnSync(["bash", POLICY], {
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: repository,
    },
  });
}

describe("self-hosted pre-job policy", () => {
  test("accepts a same-repository pull request", async () => {
    expect((await runPolicy()).exitCode).toBe(0);
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
