#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// Manual events that accept a repository ref execute the workflow definition at
// that ref. A guard inside such a definition cannot protect itself: an older or
// hostile branch can omit the guard. This repository therefore permits manual
// operation only through typed repository events, which GitHub binds to the
// default branch's current SHA.
//
// Bun.YAML is deliberately used instead of a line-oriented scanner. GitHub
// accepts YAML block indentation indicators and flow mappings, so `run: |2` and
// `with: { ref: ... }` must be inspected as the same structures as their common
// block-style equivalents. Bun 1.3.4 applies YAML 1.1 boolean-key semantics and
// parses the unquoted top-level `on` key as `true`; workflowTriggers handles that
// documented parser behaviour explicitly.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";
const BRANCH_SELECTABLE_DISPATCH = ["workflow", "dispatch"].join("_");
const ALLOWED_CLIENT_PAYLOAD_EXPRESSION = "${{ toJSON(github.event.client_payload) }}";
const TRUSTED_SOURCE_RUNS_ON =
  "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && 'osf-pr' || 'ubuntu-latest' }}";
const MAIN_REF_CONDITION = "github.ref == 'refs/heads/main'";
const TRUSTED_PUBLISH_CONDITION =
  "(github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))) || (github.event_name == 'repository_dispatch' && github.ref == 'refs/heads/main')";

export const DEFAULT_MANUAL_WORKFLOWS = [
  {
    path: ".github/workflows/deploy.yml",
    dispatchType: "deploy",
    payloadJob: "deploy",
    payloadStepId: "request",
  },
  {
    path: ".github/workflows/e2e-cluster.yml",
    dispatchType: "e2e-cluster",
    payloadJob: "e2e",
    payloadStepId: "request",
  },
  {
    path: ".github/workflows/docker-api.yml",
    dispatchType: "publish-images",
    payloadJob: "publish",
    payloadStepId: "request",
  },
  {
    path: ".github/workflows/docker-keycloak.yml",
    dispatchType: "publish-images",
    payloadJob: "publish",
    payloadStepId: "request",
  },
  {
    path: ".github/workflows/web-e2e.yml",
    dispatchType: "web-e2e",
    payloadJob: "browser-e2e",
    payloadStepId: "request",
  },
];

export const DEFAULT_PRIVILEGED_JOBS = [
  { path: ".github/workflows/deploy.yml", job: "deploy", condition: MAIN_REF_CONDITION },
  { path: ".github/workflows/e2e-cluster.yml", job: "e2e", condition: MAIN_REF_CONDITION },
  {
    path: ".github/workflows/docker-api.yml",
    job: "publish",
    condition: TRUSTED_PUBLISH_CONDITION,
  },
  {
    path: ".github/workflows/docker-keycloak.yml",
    job: "publish",
    condition: TRUSTED_PUBLISH_CONDITION,
  },
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function parseWorkflow(source, path) {
  let workflow;
  try {
    workflow = Bun.YAML.parse(source);
  } catch (error) {
    throw new Error(
      `${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(workflow)) throw new Error(`${path}: workflow root must be a mapping`);
  if (hasOwn(workflow, "on") && hasOwn(workflow, "true")) {
    throw new Error(
      `${path}: ambiguous trigger mapping contains both "on" and YAML-1.1-coerced "true" keys`,
    );
  }
  return workflow;
}

function workflowTriggers(workflow) {
  if (hasOwn(workflow, "on")) return workflow.on;
  // Bun.YAML 1.1 parses an unquoted `on:` mapping key as boolean true, which is
  // stringified to the object key "true" by JavaScript.
  if (hasOwn(workflow, "true")) return workflow.true;
  return undefined;
}

function hasTrigger(triggers, trigger) {
  if (typeof triggers === "string") return triggers === trigger;
  if (Array.isArray(triggers)) return triggers.includes(trigger);
  return hasOwn(triggers, trigger);
}

function normalizeCondition(value) {
  const condition = typeof value === "string" ? value : "";
  const expression = condition.match(/^\$\{\{\s*(.*?)\s*\}\}$/)?.[1] ?? condition;
  return expression.trim().replace(/\s+/g, " ");
}

function expressionBodies(value, includeBare = false) {
  const expressions = [];
  for (const match of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    expressions.push({ source: match[0], body: match[1] });
  }
  if (includeBare) expressions.push({ source: value, body: value });
  return expressions;
}

function findDispatchExpressions(value, includeBare = false) {
  const findings = [];
  for (const expression of expressionBodies(value, includeBare)) {
    const referencesInputs =
      /(^|[^\w.])inputs\b/i.test(expression.body) ||
      /(^|[^\w.])github\.event\.inputs\b/i.test(expression.body);
    const referencesClientPayload =
      /(^|[^\w.])github\.event\.client_payload\b/i.test(expression.body) ||
      /(^|[^\w.])client_payload\b/i.test(expression.body) ||
      /github\s*(?:\.\s*event|\[\s*["']event["']\s*\])\s*\[/i.test(expression.body);
    if (referencesInputs || referencesClientPayload) {
      findings.push({
        expression: expression.source,
        referencesInputs,
        referencesClientPayload,
      });
    }
  }
  return findings;
}

function referencesSecrets(value, includeBare = false) {
  if (typeof value !== "string") return false;
  for (const expression of expressionBodies(value, includeBare)) {
    if (/(^|[^\w])secrets(?=$|[^\w])/i.test(expression.body)) return true;
  }
  return false;
}

function referencesRepositoryEventObject(value, includeBare = false) {
  if (typeof value !== "string") return false;
  for (const expression of expressionBodies(value, includeBare)) {
    if (
      /github\s*\.\s*event\b/i.test(expression.body) ||
      /github\s*\[/i.test(expression.body) ||
      /toJSON\s*\(\s*github\s*\)/i.test(expression.body) ||
      /^\s*github\s*$/i.test(expression.body)
    ) {
      return true;
    }
  }
  return false;
}

function referencesGithubEventPath(value, includeBare = false) {
  if (typeof value !== "string") return false;
  return expressionBodies(value, includeBare).some(
    (expression) =>
      /github\s*\.\s*event_path\b/i.test(expression.body) ||
      /github\s*\[\s*["']event_path["']\s*\]/i.test(expression.body),
  );
}

function referencesEventPathEnvironment(value) {
  return /(^|[^A-Za-z0-9_])GITHUB_EVENT_PATH(?=$|[^A-Za-z0-9_])/i.test(value);
}

function visitScalars(value, path, visitor) {
  if (typeof value === "string") {
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitScalars(entry, [...path, index], visitor));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitScalars(entry, [...path, key], visitor);
  }
}

function formatYamlPath(path) {
  return path.reduce(
    (result, segment) =>
      typeof segment === "number" ? `${result}[${segment}]` : `${result}${result ? "." : ""}${segment}`,
    "",
  );
}

function containsSecretReference(value) {
  let found = false;
  visitScalars(value, [], (scalar, yamlPath) => {
    if (referencesSecrets(scalar, yamlPath.at(-1) === "if")) found = true;
  });
  return found;
}

function isAllowedClientPayloadIngress(value, yamlPath) {
  return (
    value === ALLOWED_CLIENT_PAYLOAD_EXPRESSION &&
    yamlPath.length === 6 &&
    yamlPath[0] === "jobs" &&
    typeof yamlPath[1] === "string" &&
    yamlPath[2] === "steps" &&
    typeof yamlPath[3] === "number" &&
    yamlPath[4] === "env" &&
    yamlPath[5] === "DISPATCH_PAYLOAD_JSON"
  );
}

function isAllowedTrustedRunnerRouting(value, yamlPath) {
  return (
    value === TRUSTED_SOURCE_RUNS_ON &&
    yamlPath.length === 3 &&
    yamlPath[0] === "jobs" &&
    typeof yamlPath[1] === "string" &&
    yamlPath[2] === "runs-on"
  );
}

function clientPayloadIngresses(workflow) {
  const ingresses = [];
  visitScalars(workflow, [], (value, yamlPath) => {
    if (!isAllowedClientPayloadIngress(value, yamlPath)) return;
    const jobName = yamlPath[1];
    const stepIndex = yamlPath[3];
    const step = workflow.jobs?.[jobName]?.steps?.[stepIndex];
    ingresses.push({ job: jobName, stepId: isRecord(step) ? step.id : undefined });
  });
  return ingresses;
}

/** Return dispatch expressions embedded in parsed run scalars. */
export function findUnsafeRunExpressions(source, path = "workflow.yml") {
  const workflow = parseWorkflow(source, path);
  const findings = [];
  visitScalars(workflow, [], (value, yamlPath) => {
    if (yamlPath.at(-1) !== "run") return;
    for (const finding of findDispatchExpressions(value)) {
      findings.push({ path, yamlPath: formatYamlPath(yamlPath), expression: finding.expression });
    }
  });
  return findings;
}

function checkPayloadExpressionPaths(workflow, path) {
  const problems = [];
  const typedRepositoryDispatch = hasTrigger(workflowTriggers(workflow), "repository_dispatch");
  visitScalars(workflow, [], (value, yamlPath) => {
    const bareExpression = yamlPath.at(-1) === "if";
    const findings = findDispatchExpressions(value, bareExpression);
    const renderedPath = formatYamlPath(yamlPath);
    if (typedRepositoryDispatch && findings.some((finding) => finding.referencesInputs)) {
      problems.push(
        `${path}:${renderedPath}: legacy inputs contexts are forbidden in typed repository_dispatch workflows`,
      );
      return;
    }
    if (
      findings.some((finding) => finding.referencesClientPayload) &&
      !isAllowedClientPayloadIngress(value, yamlPath)
    ) {
      problems.push(
        `${path}:${renderedPath}: client_payload is allowed only as the exact ` +
          `${ALLOWED_CLIENT_PAYLOAD_EXPRESSION} value of a step-level env.DISPATCH_PAYLOAD_JSON`,
      );
      return;
    }
    if (
      typedRepositoryDispatch &&
      (referencesGithubEventPath(value, bareExpression) || referencesEventPathEnvironment(value))
    ) {
      problems.push(
        `${path}:${renderedPath}: typed repository_dispatch workflows must not read the GitHub event payload file`,
      );
      return;
    }
    if (
      typedRepositoryDispatch &&
      referencesRepositoryEventObject(value, bareExpression) &&
      !isAllowedClientPayloadIngress(value, yamlPath) &&
      !isAllowedTrustedRunnerRouting(value, yamlPath)
    ) {
      problems.push(
        `${path}:${renderedPath}: the untrusted repository event is allowed only through the exact client_payload ingress`,
      );
      return;
    }
    for (const finding of findings) {
      if (yamlPath.at(-1) !== "run") continue;
      problems.push(
        `${path}:${renderedPath}: dispatch value ${finding.expression} is embedded in shell source; pass it through env and validate it`,
      );
    }
  });
  return problems;
}

function checkoutProblems(steps, path, jobName) {
  if (!Array.isArray(steps)) return [`${path}: privileged job "${jobName}" has no steps array`];
  const problems = [];
  let checkoutCount = 0;
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step) || typeof step.uses !== "string") continue;
    if (!step.uses.startsWith("actions/checkout@")) continue;
    checkoutCount += 1;
    if (!/^actions\/checkout@[0-9a-f]{40}$/.test(step.uses)) {
      problems.push(`${path}:jobs.${jobName}.steps[${index}]: checkout action must use a full SHA`);
    }
    if (hasOwn(step.with, "ref") || hasOwn(step.with, "repository")) {
      problems.push(
        `${path}:jobs.${jobName}.steps[${index}]: trusted checkout must not override ref or repository`,
      );
    }
  }
  if (checkoutCount === 0) {
    problems.push(`${path}: privileged job "${jobName}" has no actions/checkout step`);
  }
  return problems;
}

function checkManualWorkflow(workflow, policy) {
  const triggers = workflowTriggers(workflow);
  if (!isRecord(triggers) || !hasOwn(triggers, "repository_dispatch")) {
    return [`${policy.path}: missing repository_dispatch trigger`];
  }
  const dispatch = triggers.repository_dispatch;
  const types = isRecord(dispatch) ? dispatch.types : undefined;
  const problems = [];
  if (
    !Array.isArray(types) ||
    types.length !== 1 ||
    types[0] !== policy.dispatchType
  ) {
    problems.push(
      `${policy.path}: repository_dispatch must declare exactly types: [${policy.dispatchType}]`,
    );
  }
  const ingresses = clientPayloadIngresses(workflow);
  const ingress = ingresses[0];
  if (
    ingresses.length !== 1 ||
    ingress?.job !== policy.payloadJob ||
    ingress?.stepId !== policy.payloadStepId
  ) {
    const found = ingresses
      .map((entry) => `${entry.job}#${entry.stepId ?? "<no-id>"}`)
      .join(", ");
    problems.push(
      `${policy.path}: client_payload ingress must appear exactly once at ` +
        `${policy.payloadJob}#${policy.payloadStepId}; found [${found}]`,
    );
  }
  return problems;
}

function checkPrivilegedJob(workflow, policy) {
  const jobs = workflow.jobs;
  const job = isRecord(jobs) ? jobs[policy.job] : undefined;
  if (!isRecord(job)) return [`${policy.path}: privileged job "${policy.job}" was not found`];

  const problems = [];
  const condition = normalizeCondition(job.if);
  if (condition !== policy.condition) {
    problems.push(
      `${policy.path}:jobs.${policy.job}.if must be exactly: ${policy.condition}`,
    );
  }
  problems.push(...checkoutProblems(job.steps, policy.path, policy.job));
  return problems;
}

function effectivePermissions(workflow, job) {
  return job.permissions ?? workflow.permissions;
}

function hasPrivilegedPermission(permissions) {
  // An omitted permissions block inherits the repository's configurable
  // GITHUB_TOKEN default, which may still be write-capable. Treat that as
  // privileged until the workflow narrows it explicitly.
  if (permissions === undefined || permissions === null) return true;
  if (permissions === "write-all") return true;
  return isRecord(permissions) && Object.values(permissions).includes("write");
}

function workflowInheritsSecrets(workflow) {
  if (hasOwn(workflow, "secrets")) return true;
  const inherited = Object.fromEntries(
    Object.entries(workflow).filter(([key]) => key !== "jobs" && key !== "on" && key !== "true"),
  );
  return containsSecretReference(inherited);
}

function jobConsumesSecrets(workflow, job) {
  return (
    workflowInheritsSecrets(workflow) ||
    hasOwn(job, "secrets") ||
    containsSecretReference(job)
  );
}

function discoveredPrivilegedJobs(sources) {
  const discovered = [];
  for (const [path, workflow] of sources) {
    if (!isRecord(workflow.jobs)) continue;
    const pullRequestTarget = hasTrigger(workflowTriggers(workflow), "pull_request_target");
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job)) continue;
      if (
        pullRequestTarget ||
        jobConsumesSecrets(workflow, job) ||
        hasOwn(job, "environment") ||
        hasPrivilegedPermission(effectivePermissions(workflow, job))
      ) {
        discovered.push(`${path}#${jobName}`);
      }
    }
  }
  return discovered.sort();
}

export async function checkDeployWorkflows({
  repoRoot = REPO_ROOT,
  workflowDir = WORKFLOW_DIR,
  manualWorkflows = DEFAULT_MANUAL_WORKFLOWS,
  privilegedJobs = DEFAULT_PRIVILEGED_JOBS,
} = {}) {
  const workflowRoot = join(repoRoot, workflowDir);
  const files = (await readdir(workflowRoot))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const sources = new Map();
  const problems = [];

  for (const file of files) {
    const path = join(workflowDir, file);
    const source = await readFile(join(repoRoot, path), "utf8");
    let workflow;
    try {
      workflow = parseWorkflow(source, path);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    sources.set(path, workflow);
    const triggers = workflowTriggers(workflow);
    if (hasTrigger(triggers, BRANCH_SELECTABLE_DISPATCH)) {
      problems.push(`${path}: branch-selectable manual dispatch triggers are forbidden`);
    }
    problems.push(...checkPayloadExpressionPaths(workflow, path));
  }

  const manualByPath = new Map(manualWorkflows.map((policy) => [policy.path, policy]));
  for (const [path, workflow] of sources) {
    const triggers = workflowTriggers(workflow);
    if (hasTrigger(triggers, "repository_dispatch") && !manualByPath.has(path)) {
      problems.push(`${path}: repository_dispatch workflow is missing from the manual policy`);
    }
  }
  for (const policy of manualWorkflows) {
    const workflow = sources.get(policy.path);
    if (!workflow) {
      problems.push(`${policy.path}: manual workflow was not found`);
      continue;
    }
    problems.push(...checkManualWorkflow(workflow, policy));
  }

  for (const policy of privilegedJobs) {
    const workflow = sources.get(policy.path);
    if (!workflow) {
      problems.push(`${policy.path}: privileged workflow was not found`);
      continue;
    }
    problems.push(...checkPrivilegedJob(workflow, policy));
  }

  const expectedPrivileged = privilegedJobs
    .map((policy) => `${policy.path}#${policy.job}`)
    .sort();
  const actualPrivileged = discoveredPrivilegedJobs(sources);
  if (JSON.stringify(actualPrivileged) !== JSON.stringify(expectedPrivileged)) {
    problems.push(
      "privileged job policy is out of sync: " +
        `expected [${expectedPrivileged.join(", ")}], found [${actualPrivileged.join(", ")}]`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      "Deploy workflow trust checks failed:\n" +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    );
  }

  return {
    workflowCount: files.length,
    manualWorkflowCount: manualWorkflows.length,
    privilegedJobCount: privilegedJobs.length,
  };
}

if (import.meta.main) {
  try {
    const result = await checkDeployWorkflows();
    console.log(
      `Deploy workflow trust checks passed for ${result.workflowCount} workflows: ` +
        "0 branch-selectable manual triggers; " +
        `${result.manualWorkflowCount} typed default-branch manual workflows; ` +
        `${result.privilegedJobCount} privileged jobs pinned to trusted refs and default checkouts.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
