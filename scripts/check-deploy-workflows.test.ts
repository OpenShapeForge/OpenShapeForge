// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDeployWorkflows,
  findUnsafeRunExpressions,
} from "./check-deploy-workflows.mjs";

const fixtures: string[] = [];
const branchSelectableDispatch = ["workflow", "dispatch"].join("_");
const repoRoot = join(import.meta.dir, "..");

async function createFixture(workflows: Record<string, string>) {
  const repoRoot = await mkdtemp(join(tmpdir(), "openshapeforge-deploy-workflow-"));
  fixtures.push(repoRoot);
  await mkdir(join(repoRoot, ".github/workflows"), { recursive: true });
  await Promise.all(
    Object.entries(workflows).map(([name, source]) =>
      writeFile(join(repoRoot, ".github/workflows", name), source),
    ),
  );
  return repoRoot;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const trustedWorkflow = `on:
  repository_dispatch:
    types: [deploy]
permissions: { contents: read }
jobs:
  deploy:
    if: github.ref == 'refs/heads/main'
    environment: dev
    steps:
      - uses: actions/checkout@0123456789012345678901234567890123456789
      - name: Safe payload path
        id: request
        env:
          DISPATCH_PAYLOAD_JSON: \${{ toJSON(github.event.client_payload) }}
        run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
`;

const manualPolicy = [
  {
    path: ".github/workflows/deploy.yml",
    dispatchType: "deploy",
    payloadJob: "deploy",
    payloadStepId: "request",
  },
];
const privilegedPolicy = [
  {
    path: ".github/workflows/deploy.yml",
    job: "deploy",
    condition: "github.ref == 'refs/heads/main'",
  },
];

async function checkFixture(workflow: string, options = {}) {
  const repoRoot = await createFixture({ "deploy.yml": workflow });
  return checkDeployWorkflows({
    repoRoot,
    manualWorkflows: manualPolicy,
    privilegedJobs: privilegedPolicy,
    ...options,
  });
}

async function checkUnprivilegedFixture(workflow: string) {
  const repoRoot = await createFixture({ "fixture.yml": workflow });
  return checkDeployWorkflows({ repoRoot, manualWorkflows: [], privilegedJobs: [] });
}

async function runWorkflowStep(
  workflowName: string,
  jobName: string,
  stepName: string,
  env: Record<string, string>,
) {
  const source = await readFile(join(repoRoot, ".github/workflows", workflowName), "utf8");
  const workflow = Bun.YAML.parse(source) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const script = workflow.jobs[jobName].steps.find((step) => step.name === stepName)?.run;
  if (!script) throw new Error(`${workflowName}:${jobName} has no step named ${stepName}`);

  const outputRoot = await mkdtemp(join(tmpdir(), "openshapeforge-dispatch-preflight-"));
  fixtures.push(outputRoot);
  const githubEnv = join(outputRoot, "github-env");
  const githubOutput = join(outputRoot, "github-output");
  await Promise.all([writeFile(githubEnv, ""), writeFile(githubOutput, "")]);
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const processHandle = Bun.spawn({
    cmd: ["bash", "-c", script],
    cwd: repoRoot,
    env: { ...inheritedEnv, ...env, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: githubOutput },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(processHandle.stdout).text();
  const stderrPromise = new Response(processHandle.stderr).text();
  const exitCode = await processHandle.exited;
  const [stdout, stderr, environment, output] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    readFile(githubEnv, "utf8"),
    readFile(githubOutput, "utf8"),
  ]);
  return { exitCode, stdout, stderr, environment, output };
}

describe("deploy workflow trust check", () => {
  test("accepts typed default-branch dispatch with payload passed through env", async () => {
    await expect(checkFixture(trustedWorkflow)).resolves.toEqual({
      workflowCount: 1,
      manualWorkflowCount: 1,
      privilegedJobCount: 1,
    });
  });

  test("rejects branch-selectable manual triggers repository-wide", async () => {
    const unsafe = trustedWorkflow.replace("repository_dispatch", branchSelectableDispatch);
    await expect(checkFixture(unsafe)).rejects.toThrow(
      /branch-selectable manual dispatch triggers are forbidden/,
    );
  });

  test("rejects branch-selectable manual triggers in a flow sequence", async () => {
    const unsafe = trustedWorkflow.replace(
      `on:
  repository_dispatch:
    types: [deploy]`,
      `on: [push, ${branchSelectableDispatch}]`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(
      /branch-selectable manual dispatch triggers are forbidden/,
    );
  });

  test("rejects legacy input expressions embedded in inline shell source", async () => {
    const unsafe = trustedWorkflow.replace(
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
      `run: echo "\${{ inputs.tag }}"`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/legacy inputs contexts are forbidden/);
  });

  test("rejects legacy input expressions in env and flow-style action inputs", async () => {
    for (const extraStep of [
      `- name: Legacy env
        env: { LEGACY: "\${{ inputs.tag }}" }
        run: echo safe`,
      `- uses: example/action@0123456789012345678901234567890123456789
        with: { tag: "\${{ github.event.inputs.tag }}" }`,
    ]) {
      const unsafe = trustedWorkflow.replace(
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      ${extraStep}`,
      );
      await expect(checkFixture(unsafe)).rejects.toThrow(/legacy inputs contexts are forbidden/);
    }
  });

  test("parses explicit-indent block scalars before auditing shell source", () => {
    const findings = findUnsafeRunExpressions(`jobs:
  deploy:
    steps:
      - run: |2
          echo "\${{ github.event.client_payload.tag }}"
`);
    expect(findings).toEqual([
      {
        path: "workflow.yml",
        yamlPath: "jobs.deploy.steps[0].run",
        expression: "\${{ github.event.client_payload.tag }}",
      },
    ]);
  });

  test("rejects explicit-indent block scalar payload interpolation end to end", async () => {
    const unsafe = trustedWorkflow.replace(
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
      `run: |2
          echo "\${{ github.event.client_payload.tag }}"`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/client_payload is allowed only/);
  });

  test("rejects client payload expressions outside the exact step env ingress", async () => {
    const unsafe = trustedWorkflow.replace(
      "environment: dev",
      "environment: \${{ github.event['client_payload'].environment }}",
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/client_payload is allowed only/);
  });

  test("allows the exact trusted-source runner routing expression", async () => {
    const routed = trustedWorkflow.replace(
      "environment: dev",
      `runs-on: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && 'osf-pr' || 'ubuntu-latest' }}
    environment: dev`,
    );
    await expect(checkFixture(routed)).resolves.toEqual({
      workflowCount: 1,
      manualWorkflowCount: 1,
      privilegedJobCount: 1,
    });
  });

  test("rejects any relaxed trusted-source runner routing expression", async () => {
    const routed = trustedWorkflow.replace(
      "environment: dev",
      `runs-on: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == false && 'osf-pr' || 'ubuntu-latest' }}
    environment: dev`,
    );
    await expect(checkFixture(routed)).rejects.toThrow(
      /untrusted repository event is allowed only/,
    );
  });

  test("rejects the whole client payload at workflow env scope", async () => {
    const unsafe = trustedWorkflow.replace(
      "jobs:",
      `env:
  DISPATCH_PAYLOAD_JSON: \${{ toJSON(github.event.client_payload) }}
jobs:`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/client_payload is allowed only/);
  });

  test("rejects client payload fields in a flow-style step env", async () => {
    const unsafe = trustedWorkflow.replace(
      `env:
          DISPATCH_PAYLOAD_JSON: \${{ toJSON(github.event.client_payload) }}`,
      `env: { DISPATCH_PAYLOAD_JSON: "\${{ github.event.client_payload.ref }}" }`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/client_payload is allowed only/);
  });

  test("rejects smuggling the whole repository event through another env", async () => {
    const unsafe = trustedWorkflow.replace(
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      - name: Whole event
        env: { EVENT_JSON: "\${{ toJSON(github.event) }}" }
        run: echo safe`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(
      /untrusted repository event is allowed only/,
    );
  });

  test("rejects bare client payload expressions in implicit if syntax", async () => {
    const unsafe = trustedWorkflow.replace(
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      - name: Bare payload condition
        if: github.event.client_payload.deploy
        run: echo unsafe`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/client_payload is allowed only/);
  });

  test("rejects bare legacy inputs and whole-event if expressions", async () => {
    for (const condition of ["inputs.tag", "toJSON(github.event)"]) {
      const unsafe = trustedWorkflow.replace(
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      - name: Bare untrusted condition
        if: ${condition}
        run: echo unsafe`,
      );
      await expect(checkFixture(unsafe)).rejects.toThrow(
        /legacy inputs contexts are forbidden|untrusted repository event is allowed only/,
      );
    }
  });

  test("rejects direct shell reads from GITHUB_EVENT_PATH", async () => {
    for (const eventPath of ["$GITHUB_EVENT_PATH", "${GITHUB_EVENT_PATH}"]) {
      const unsafe = trustedWorkflow.replace(
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      - name: Read event file
        run: jq . "${eventPath}"`,
      );
      await expect(checkFixture(unsafe)).rejects.toThrow(/must not read the GitHub event payload file/);
    }
  });

  test("rejects github.event_path passed through step env", async () => {
    for (const expression of [
      "\${{ github.event_path }}",
      "\${{ github['EVENT_PATH'] }}",
    ]) {
      const unsafe = trustedWorkflow.replace(
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
        `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      - name: Alias event file
        env: { EVENT_FILE: "${expression}" }
        run: jq . "$EVENT_FILE"`,
      );
      await expect(checkFixture(unsafe)).rejects.toThrow(/must not read the GitHub event payload file/);
    }
  });

  test("does not confuse longer shell variable names with GITHUB_EVENT_PATH", async () => {
    const safe = trustedWorkflow.replace(
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      - name: Unrelated variable
        run: printf '%s\\n' "$MY_GITHUB_EVENT_PATH_COPY"`,
    );
    await expect(checkFixture(safe)).resolves.toEqual({
      workflowCount: 1,
      manualWorkflowCount: 1,
      privilegedJobCount: 1,
    });
  });

  test("rejects the allowed payload expression under any other env key", async () => {
    const unsafe = trustedWorkflow.replace("DISPATCH_PAYLOAD_JSON:", "RAW_PAYLOAD:");
    await expect(checkFixture(unsafe)).rejects.toThrow(/client_payload is allowed only/);
  });

  test("rejects duplicate exact client payload ingresses", async () => {
    const unsafe = trustedWorkflow.replace(
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
      `run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"
      - name: Duplicate payload ingress
        id: duplicate
        env:
          DISPATCH_PAYLOAD_JSON: \${{ toJSON(github.event.client_payload) }}
        run: printf '%s\\n' "$DISPATCH_PAYLOAD_JSON"`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/must appear exactly once/);
  });

  test("rejects moving the sole payload ingress to an unapproved step", async () => {
    const unsafe = trustedWorkflow.replace("id: request", "id: moved");
    await expect(checkFixture(unsafe)).rejects.toThrow(/deploy#request/);
  });

  test("rejects a privileged job without its exact trusted condition", async () => {
    const unsafe = trustedWorkflow.replace(
      "if: github.ref == 'refs/heads/main'",
      "if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')",
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/jobs\.deploy\.if must be exactly/);
  });

  test("rejects an inline flow-mapping checkout ref override", async () => {
    const unsafe = trustedWorkflow.replace(
      "- uses: actions/checkout@0123456789012345678901234567890123456789",
      `- uses: actions/checkout@0123456789012345678901234567890123456789
        with: { ref: "\${{ github.event.client_payload.ref }}" }`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(
      /trusted checkout must not override ref or repository/,
    );
  });

  test("rejects a privileged checkout of pull-request head code", async () => {
    const unsafe = trustedWorkflow.replace(
      "- uses: actions/checkout@0123456789012345678901234567890123456789",
      `- uses: actions/checkout@0123456789012345678901234567890123456789
        with: { ref: "\${{ github.event.pull_request.head.sha }}" }`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(
      /trusted checkout must not override ref or repository/,
    );
  });

  test("rejects a mutable checkout action reference", async () => {
    const unsafe = trustedWorkflow.replace(
      "actions/checkout@0123456789012345678901234567890123456789",
      "actions/checkout@v4",
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/checkout action must use a full SHA/);
  });

  test("rejects an unexpected repository dispatch type", async () => {
    const unsafe = trustedWorkflow.replace("types: [deploy]", "types: [anything]");
    await expect(checkFixture(unsafe)).rejects.toThrow(
      /repository_dispatch must declare exactly types: \[deploy\]/,
    );
  });

  test("rejects unlisted repository dispatch workflows", async () => {
    const repoRoot = await createFixture({
      "deploy.yml": trustedWorkflow,
      "extra.yml": `on:
  repository_dispatch:
    types: [extra]
jobs: {}
`,
    });
    await expect(
      checkDeployWorkflows({
        repoRoot,
        manualWorkflows: manualPolicy,
        privilegedJobs: privilegedPolicy,
      }),
    ).rejects.toThrow(/extra\.yml: repository_dispatch workflow is missing from the manual policy/);
  });

  test("rejects privileged jobs missing from the explicit policy", async () => {
    const unsafe = trustedWorkflow.replace(
      "jobs:",
      `jobs:
  unmodelled:
    permissions: { packages: write }
    steps: []`,
    );
    await expect(checkFixture(unsafe)).rejects.toThrow(/privileged job policy is out of sync/);
  });

  test("discovers dot, bracket, and toJSON secret context expressions", async () => {
    const expressions = [
      "\${{ secrets.TOKEN }}",
      "\${{ secrets['TOKEN'] }}",
      "\${{ toJSON(secrets) }}",
    ];
    for (const expression of expressions) {
      await expect(
        checkUnprivilegedFixture(`on: push
permissions: { contents: read }
jobs:
  consume:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
        env: { VALUE: "${expression}" }
`),
      ).rejects.toThrow(/privileged job policy is out of sync/);
    }
  });

  test("discovers reusable jobs with inherited or mapped secrets", async () => {
    for (const secretBinding of [
      "secrets: inherit",
      `secrets: { token: "\${{ secrets.TOKEN }}" }`,
    ]) {
      await expect(
        checkUnprivilegedFixture(`on: push
permissions: { contents: read }
jobs:
  reuse:
    uses: example/repository/.github/workflows/reusable.yml@0123456789012345678901234567890123456789
    ${secretBinding}
`),
      ).rejects.toThrow(/privileged job policy is out of sync/);
    }
  });

  test("treats workflow-level secret env as inherited by every job", async () => {
    await expect(
      checkUnprivilegedFixture(`on: push
permissions: { contents: read }
env:
  TOKEN: \${{ secrets.TOKEN }}
jobs:
  ordinary:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
`),
    ).rejects.toThrow(/privileged job policy is out of sync/);
  });

  test("treats workflow-level secret inheritance as privileged", async () => {
    await expect(
      checkUnprivilegedFixture(`on: push
permissions: { contents: read }
secrets: inherit
jobs:
  ordinary:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
`),
    ).rejects.toThrow(/privileged job policy is out of sync/);
  });

  test("treats every pull_request_target job as privileged", async () => {
    await expect(
      checkUnprivilegedFixture(`on: pull_request_target
permissions: { contents: read }
jobs:
  target:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
`),
    ).rejects.toThrow(/privileged job policy is out of sync/);
  });

  test("rejects ambiguous on and YAML-1.1 true trigger mappings", async () => {
    await expect(
      checkUnprivilegedFixture(`"on": push
"true": pull_request_target
jobs: {}
`),
    ).rejects.toThrow(/ambiguous trigger mapping/);
  });

  test("treats a missing permissions block as repository-default privilege", async () => {
    await expect(
      checkUnprivilegedFixture(`on: push
jobs:
  implicit-token:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
`),
    ).rejects.toThrow(/privileged job policy is out of sync/);
  });

  test("accepts an ordinary job only after token permissions are explicit", async () => {
    await expect(
      checkUnprivilegedFixture(`on: push
permissions: { contents: read }
jobs:
  explicit-token:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
`),
    ).resolves.toEqual({
      workflowCount: 1,
      manualWorkflowCount: 0,
      privilegedJobCount: 0,
    });
  });
});

describe("repository event payload preflights", () => {
  test("deploy applies production defaults when client payload is omitted", async () => {
    const result = await runWorkflowStep(
      "deploy.yml",
      "deploy",
      "Preflight — deployment request is valid",
      { DISPATCH_PAYLOAD_JSON: "null", GITHUB_EVENT_NAME: "repository_dispatch" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.environment).toContain("DISPATCH_DEPLOY_KEYCLOAK=true\n");
    expect(result.environment).toContain("DISPATCH_API_HOST=api.openshapeforge.eu\n");
    expect(result.environment).toContain("DISPATCH_REALM_MODE=production\n");
    expect(result.output).toBe("deploy_keycloak=true\nrealm_mode=production\n");
  });

  test("deploy rejects unknown keys, wrong JSON types, and shell metacharacters", async () => {
    const payloads = [
      { unknown: "value" },
      { deploy_keycloak: "true" },
      { image_tag: "valid;id" },
      { bearer_audience: "erp,auth.enabled=true" },
    ];
    for (const payload of payloads) {
      const result = await runWorkflowStep(
        "deploy.yml",
        "deploy",
        "Preflight — deployment request is valid",
        {
          DISPATCH_PAYLOAD_JSON: JSON.stringify(payload),
          GITHUB_EVENT_NAME: "repository_dispatch",
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.environment).toBe("");
    }
  });

  test("deploy rejects the documented development payload with public hosts", async () => {
    const result = await runWorkflowStep(
      "deploy.yml",
      "deploy",
      "Preflight — deployment request is valid",
      {
        DISPATCH_PAYLOAD_JSON: JSON.stringify({
          image_tag: "sha-0123abc",
          deploy_keycloak: true,
          api_host: "api.review.openshapeforge.eu",
          auth_host: "auth.review.openshapeforge.eu",
          realm_mode: "development",
          tls_issuer: "letsencrypt-staging",
        }),
        GITHUB_EVENT_NAME: "repository_dispatch",
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.environment).toBe("");
    expect(result.output).toBe("");
  });

  test("deploy allows a development realm only without ingress hosts", async () => {
    const result = await runWorkflowStep(
      "deploy.yml",
      "deploy",
      "Preflight — deployment request is valid",
      {
        DISPATCH_PAYLOAD_JSON: JSON.stringify({
          image_tag: "sha-0123abc",
          deploy_keycloak: true,
          api_host: "",
          auth_host: "",
          realm_mode: "development",
          tls_issuer: "letsencrypt-staging",
        }),
        GITHUB_EVENT_NAME: "repository_dispatch",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.environment).toContain("DISPATCH_API_HOST=\n");
    expect(result.environment).toContain("DISPATCH_AUTH_HOST=\n");
    expect(result.environment).toContain("DISPATCH_REALM_MODE=development\n");
    expect(result.output).toContain("realm_mode=development\n");
  });

  test("cluster e2e accepts the default origin and rejects redirect-shaped URLs", async () => {
    const accepted = await runWorkflowStep(
      "e2e-cluster.yml",
      "e2e",
      "Preflight — cluster test request is valid",
      { DISPATCH_PAYLOAD_JSON: "null", GITHUB_EVENT_NAME: "repository_dispatch" },
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.environment).toBe("E2E_API_URL=https://api.openshapeforge.eu\n");

    const rejected = await runWorkflowStep(
      "e2e-cluster.yml",
      "e2e",
      "Preflight — cluster test request is valid",
      {
        DISPATCH_PAYLOAD_JSON: JSON.stringify({
          api_url: "https://api.openshapeforge.eu@evil.example",
        }),
        GITHUB_EVENT_NAME: "repository_dispatch",
      },
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.environment).toBe("");
  });

  test("cluster e2e writes Secret Manager values with randomized environment delimiters", async () => {
    const source = await readFile(
      join(repoRoot, ".github/workflows/e2e-cluster.yml"),
      "utf8",
    );
    expect(source).not.toContain('echo "$var=$value" >> "$GITHUB_ENV"');
    expect(source).not.toContain('echo "DATABASE_URL=$local_url" >> "$GITHUB_ENV"');
    expect(source).not.toContain(
      'echo "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET=$secret" >> "$GITHUB_ENV"',
    );
    expect(source.match(/delimiter="OSF_SECRET_\$\(openssl rand -hex 16\)"/g)).toHaveLength(3);
    expect(source.match(/mask="\$\{mask\/\/\$'\\n'\/'%0A'\}"/g)).toHaveLength(4);
  });

  test("both image publishers accept only an empty client payload", async () => {
    for (const workflowName of ["docker-api.yml", "docker-keycloak.yml"]) {
      const accepted = await runWorkflowStep(
        workflowName,
        "publish",
        "Preflight — publication request is empty",
        {
          DISPATCH_PAYLOAD_JSON: "null",
          GITHUB_EVENT_NAME: "repository_dispatch",
        },
      );
      expect(accepted.exitCode).toBe(0);
      expect(accepted.output).toBe("");

      for (const payload of [{ release_version: "0.2.0" }, { ref: "feature" }]) {
        const rejected = await runWorkflowStep(
          workflowName,
          "publish",
          "Preflight — publication request is empty",
          {
            DISPATCH_PAYLOAD_JSON: JSON.stringify(payload),
            GITHUB_EVENT_NAME: "repository_dispatch",
          },
        );
        expect(rejected.exitCode).not.toBe(0);
        expect(rejected.output).toBe("");
      }
    }
  });

  test("web e2e accepts no client payload fields", async () => {
    const accepted = await runWorkflowStep(
      "web-e2e.yml",
      "browser-e2e",
      "Preflight — manual browser request is empty",
      { DISPATCH_PAYLOAD_JSON: "null", GITHUB_EVENT_NAME: "repository_dispatch" },
    );
    expect(accepted.exitCode).toBe(0);

    const rejected = await runWorkflowStep(
      "web-e2e.yml",
      "browser-e2e",
      "Preflight — manual browser request is empty",
      {
        DISPATCH_PAYLOAD_JSON: JSON.stringify({ ref: "feature" }),
        GITHUB_EVENT_NAME: "repository_dispatch",
      },
    );
    expect(rejected.exitCode).not.toBe(0);
  });
});
