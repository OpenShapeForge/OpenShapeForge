// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const POLICY = join(import.meta.dir, "self-hosted-pre-job-policy.sh");
const POLICY_DIGEST = join(
  import.meta.dir,
  "self-hosted-pre-job-policy.sha256",
);
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
  const eventDirectory = join(
    fixtures,
    crypto.randomUUID(),
    "_work",
    "_temp",
    "_github_workflow",
  );
  const eventPath = join(eventDirectory, "event.json");
  if (includeEvent) {
    await mkdir(eventDirectory, { recursive: true });
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
    await chmod(eventPath, 0o600);
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
  test("matches the operator-installed policy digest", async () => {
    const source = await readFile(POLICY);
    const expected = (await readFile(POLICY_DIGEST, "utf8")).split(/\s+/)[0];
    expect(createHash("sha256").update(source).digest("hex")).toBe(expected);
  });

  test("accepts a same-repository pull request", async () => {
    expect((await runPolicy()).exitCode).toBe(0);
  });

  test("rejects a fork pull request", async () => {
    expect(
      (
        await runPolicy({
          headRepository: "contributor/OpenShapeForge",
          fork: true,
        })
      ).exitCode,
    ).not.toBe(0);
  });

  test("rejects a same-named repository still marked as a fork", async () => {
    expect((await runPolicy({ fork: true })).exitCode).not.toBe(0);
  });

  test("rejects an event payload outside the runner-owned workflow directory", async () => {
    const eventPath = join(fixtures, `${crypto.randomUUID()}.json`);
    await writeFile(eventPath, "{}");
    const result = Bun.spawnSync(["bash", POLICY], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: REPOSITORY,
      },
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("rejects a group-writable event payload", async () => {
    const eventDirectory = join(
      fixtures,
      crypto.randomUUID(),
      "_work",
      "_temp",
      "_github_workflow",
    );
    await mkdir(eventDirectory, { recursive: true });
    const eventPath = join(eventDirectory, "event.json");
    await writeFile(eventPath, "{}");
    await chmod(eventPath, 0o620);
    const result = Bun.spawnSync(["bash", POLICY], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: REPOSITORY,
      },
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("rejects pull_request_target before workflow steps", async () => {
    expect(
      (await runPolicy({ eventName: "pull_request_target" })).exitCode,
    ).not.toBe(0);
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
