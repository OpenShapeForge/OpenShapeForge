// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { auditWorkflowSources } from "./check-self-hosted-routing.mjs";

const WORKFLOW_DIR = ".github/workflows";
let baseline: Record<string, string>;

beforeAll(async () => {
  const files = (await readdir(WORKFLOW_DIR))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  baseline = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const path = join(WORKFLOW_DIR, file);
        return [path, await readFile(path, "utf8")];
      }),
    ),
  );
});

function auditMutation(
  path: string,
  mutate: (source: string) => string,
): string[] {
  const workflows = { ...baseline, [path]: mutate(baseline[path]) };
  return auditWorkflowSources(workflows).problems;
}

function injectIntoGates(line: string): string[] {
  return auditMutation(".github/workflows/ci.yml", (source) =>
    source.replace(
      "    name: Generate, typecheck, unit tests, notices\n",
      `    name: Generate, typecheck, unit tests, notices\n${line}\n`,
    ),
  );
}

describe("self-hosted routing negative fixtures", () => {
  test("rejects an unlisted workflow regardless of YAML indentation", () => {
    const workflows = {
      ...baseline,
      ".github/workflows/unlisted.yml": `name: Unlisted
on:
  pull_request:
permissions:
  contents: read
jobs:
    bypass:
        runs-on: osf-pr
        steps:
          - run: true
`,
    };
    expect(auditWorkflowSources(workflows).problems).toContain(
      ".github/workflows/unlisted.yml has no workflow runner security policy",
    );
  });

  test("rejects workflow-level permissions: write-all", () => {
    const problems = auditMutation(".github/workflows/ci.yml", (source) =>
      source.replace(
        "permissions:\n  contents: read",
        "permissions: write-all",
      ),
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml has routed jobs but workflow permissions are not exactly contents: read",
    );
  });

  test("rejects a native-only PR image build", () => {
    const problems = auditMutation(
      ".github/workflows/docker-api.yml",
      (source) => source.replace("          platforms: linux/amd64\n", ""),
    );
    expect(problems).toContain(
      ".github/workflows/docker-api.yml#build must load and smoke-test the published linux/amd64 platform",
    );
  });

  test("rejects an unused amd64 build followed by a native smoke-test build", () => {
    const problems = auditMutation(
      ".github/workflows/docker-api.yml",
      (source) =>
        source.replace(
          "      # Prove the image actually boots",
          `      - name: Replace the smoke-test image natively
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8
        with:
          context: .
          file: apps/api/Dockerfile
          load: true
          tags: openshapeforge-api:ci

      # Prove the image actually boots`,
        ),
    );
    expect(problems).toContain(
      ".github/workflows/docker-api.yml#build must load and smoke-test the published linux/amd64 platform",
    );
  });

  test("rejects a prototype-named job not owned by the policy", () => {
    const problems = auditMutation(".github/workflows/ci.yml", (source) =>
      source.replace(
        "jobs:\n",
        `jobs:
  __proto__:
    runs-on: ubuntu-latest
    permissions: write-all
    environment: production
    steps:
      - uses: docker/login-action@example
      - run: docker push example.invalid/image
`,
      ),
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#__proto__ has no explicit runner security policy",
    );
  });

  test("rejects job-level permissions: write-all", () => {
    const problems = auditMutation(
      ".github/workflows/docker-api.yml",
      (source) =>
        source.replace(
          "    permissions:\n      contents: read\n    steps:",
          "    permissions: write-all\n    steps:",
        ),
    );
    expect(problems).toContain(
      ".github/workflows/docker-api.yml#build must have exactly contents: read permissions",
    );
  });

  test("rejects a job secret reference using dot notation", () => {
    const problems = injectIntoGates(
      "    env:\n      LEAK: ${{ secrets.TEST_TOKEN }}",
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates contains repository/environment secrets",
    );
  });

  test("rejects a mixed-case secret context reference", () => {
    const problems = injectIntoGates(
      "    env:\n      LEAK: ${{ SeCrEtS.TEST_TOKEN }}",
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates contains repository/environment secrets",
    );
  });

  test("rejects a job secret reference using single-quoted bracket notation", () => {
    const problems = injectIntoGates(
      "    env:\n      LEAK: ${{ secrets['TEST_TOKEN'] }}",
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates contains repository/environment secrets",
    );
  });

  test("rejects a job secret reference using double-quoted bracket notation", () => {
    const problems = injectIntoGates(
      '    env:\n      LEAK: ${{ secrets["TEST_TOKEN"] }}',
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates contains repository/environment secrets",
    );
  });

  test("rejects a dynamically indexed secret reference", () => {
    const problems = injectIntoGates(
      "    env:\n      LEAK: ${{ secrets[env.SECRET_NAME] }}",
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates contains repository/environment secrets",
    );
  });

  test("rejects serialization of the secrets context", () => {
    const problems = injectIntoGates(
      "    env:\n      LEAK: ${{ toJSON(secrets) }}",
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates contains repository/environment secrets",
    );
  });

  test("rejects a secret reference after a quoted expression terminator", () => {
    const problems = injectIntoGates(
      `    env:\n      LEAK: "\${{ format('}} {0}', secrets.GITHUB_TOKEN) }}"`,
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates contains repository/environment secrets",
    );
  });

  test("rejects routed jobs that consume another job's outputs", () => {
    const problems = injectIntoGates("    needs: prepare");
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates must not consume outputs from another job",
    );
  });

  test("rejects routed jobs that download cross-job artifacts", () => {
    const problems = auditMutation(".github/workflows/ci.yml", (source) =>
      source.replace(
        "      - uses: actions/checkout@",
        "      - uses: actions/download-artifact@0123456789abcdef0123456789abcdef01234567\n      - uses: actions/checkout@",
      ),
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml#gates must not download cross-job artifacts",
    );
  });

  test("rejects a publish denylist that would admit pull_request_target", () => {
    const problems = auditMutation(
      ".github/workflows/docker-api.yml",
      (source) =>
        source.replace(
          "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
          "github.event_name != 'pull_request'",
        ),
    );
    expect(problems).toContain(
      ".github/workflows/docker-api.yml#publish must use the canonical main/v* publish condition",
    );
  });

  test("rejects workflow-level secret env inherited by routed jobs", () => {
    const problems = auditMutation(".github/workflows/ci.yml", (source) =>
      source.replace(
        "\njobs:\n",
        "\nenv:\n  LEAK: ${{ secrets['WORKFLOW_TOKEN'] }}\n\njobs:\n",
      ),
    );
    expect(problems).toContain(
      ".github/workflows/ci.yml exposes a workflow-level secret reference to routed jobs",
    );
  });
});
