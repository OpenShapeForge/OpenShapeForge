#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// A repository-scoped self-hosted runner executes the checked-out pull-request
// code on infrastructure we own. That is acceptable only for branches in this
// repository. Fork pull requests, release/publication jobs, deployments, and
// jobs with repository secrets must stay on GitHub-hosted runners.
// The immutable, root-owned pre-job policy enforces that source boundary before
// workflow steps run. This load-bearing drift gate inventories the
// repository-controlled half as defense in depth, but is not itself the
// security boundary: pull-request code can modify every file in its checkout.
//
// Bun's built-in YAML parser keeps this check dependency-free. It runs inside
// the existing required gates job so it adds no GitHub-hosted PR check that
// could remain red during a hosted-Actions billing outage.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";

const TRUSTED_SOURCE_RUNS_ON =
  "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && 'osf-pr' || 'ubuntu-latest' }}";
const PUBLISH_IF =
  "${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')) }}";
// Reject the context token anywhere in routed configuration. Parsing expression
// terminators is unsafe because a quoted `}}` inside format() is valid and can
// hide a later secret access. A false positive in human-readable YAML is safer
// than letting a new access syntax reach an infrastructure-owned runner.
const SECRET_REFERENCE = /\bsecrets\b/i;

/**
 * Every workflow job is inventoried deliberately. Adding a job without making
 * an explicit runner/security choice fails this check.
 *
 * routed: same-repository PR -> osf-pr; fork PR and every non-PR -> hosted.
 * hosted: never use osf-pr.
 * publish: hosted plus the fail-closed main/v* publication condition.
 */
const JOB_POLICY = {
  ".github/workflows/api-e2e.yml": {
    "api-e2e": "hosted",
  },
  ".github/workflows/backend-agent.yml": {
    "backend-agent": "hosted",
  },
  ".github/workflows/ci.yml": {
    gates: "routed",
    "keycloak-spi": "routed",
    helm: "routed",
    "db-tests": "routed",
    scan: "routed",
  },
  ".github/workflows/deploy.yml": {
    deploy: "hosted",
  },
  ".github/workflows/docker-api.yml": {
    build: "routed",
    publish: "publish",
  },
  ".github/workflows/docker-keycloak.yml": {
    build: "routed",
    publish: "publish",
  },
  ".github/workflows/e2e-cluster.yml": {
    e2e: "hosted",
  },
  ".github/workflows/package-compiler.yml": {
    pack: "hosted",
    publish: "hosted",
  },
  ".github/workflows/web-e2e.yml": {
    "browser-e2e": "routed",
  },
};

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWorkflow(path, source, problems) {
  try {
    // Bun currently applies YAML 1.1 booleans, where the GitHub-specific `on`
    // key becomes `true`. Quote only that top-level key before semantic parse.
    const workflow = Bun.YAML.parse(source.replace(/^on:/m, '"on":'));
    if (!isMapping(workflow)) {
      problems.push(`${path} must contain a YAML mapping`);
      return null;
    }
    if (workflow.jobs !== undefined && !isMapping(workflow.jobs)) {
      problems.push(`${path}#jobs must contain a YAML mapping`);
      return null;
    }
    const jobs = Object.entries(workflow.jobs ?? {}).map(([id, config]) => ({
      id,
      config,
    }));
    if (jobs.some((job) => !isMapping(job.config))) {
      problems.push(`${path} contains a job that is not a YAML mapping`);
      return null;
    }
    return { workflow, jobs };
  } catch (error) {
    problems.push(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function hasPullRequestTrigger(workflow) {
  const trigger = workflow.on;
  if (trigger === "pull_request") return true;
  if (Array.isArray(trigger)) return trigger.includes("pull_request");
  return isMapping(trigger) && Object.hasOwn(trigger, "pull_request");
}

function hasOnlyReadContents(spec) {
  return (
    isMapping(spec) &&
    Object.keys(spec).length === 1 &&
    spec.contents === "read"
  );
}

function routedJobHasOnlyReadContents(workflow, job) {
  return hasOnlyReadContents(job.config.permissions ?? workflow.permissions);
}

function containsSecretReference(value) {
  return SECRET_REFERENCE.test(JSON.stringify(value));
}

function stepsFor(job) {
  return Array.isArray(job.config.steps) ? job.config.steps : [];
}

function usesAction(job, action) {
  return stepsFor(job).some(
    (step) => isMapping(step) && String(step.uses ?? "").includes(action),
  );
}

function pushesImage(job) {
  return stepsFor(job).some(
    (step) =>
      isMapping(step) &&
      isMapping(step.with) &&
      (step.with.push === true || step.with.push === "true"),
  );
}

function buildsCanonicalImagePlatform(path, job) {
  const canonicalTag =
    path === ".github/workflows/docker-api.yml"
      ? "openshapeforge-api:ci"
      : "openshapeforge-keycloak:ci";
  const buildSteps = stepsFor(job).filter(
    (step) =>
      isMapping(step) &&
      String(step.uses ?? "").includes("docker/build-push-action@"),
  );
  if (buildSteps.length !== 1) return false;
  const build = buildSteps[0];
  if (
    !isMapping(build.with) ||
    build.with.platforms !== "linux/amd64" ||
    (build.with.load !== true && build.with.load !== "true") ||
    !String(build.with.tags ?? "")
      .split(/\s+/)
      .includes(canonicalTag)
  ) {
    return false;
  }
  if (
    stepsFor(job).some(
      (step) =>
        isMapping(step) &&
        typeof step.run === "string" &&
        /(^|\n)\s*docker\s+(?:build|buildx\s+build)\b/.test(step.run),
    )
  ) {
    return false;
  }
  return stepsFor(job).some(
    (step) =>
      isMapping(step) &&
      step.name === "Smoke test the image" &&
      typeof step.run === "string" &&
      step.run.includes(canonicalTag),
  );
}

function routedJobProblems(path, workflow, job) {
  const problems = [];
  if (!hasPullRequestTrigger(workflow)) {
    problems.push(
      `${path}#${job.id} is routed but its workflow has no pull_request trigger`,
    );
  }
  if (job.config["runs-on"] !== TRUSTED_SOURCE_RUNS_ON) {
    problems.push(
      `${path}#${job.id} must use the canonical trusted-source runs-on expression`,
    );
  }
  if (!routedJobHasOnlyReadContents(workflow, job)) {
    problems.push(
      `${path}#${job.id} must have exactly contents: read permissions`,
    );
  }
  if (Object.hasOwn(job.config, "environment")) {
    problems.push(`${path}#${job.id} contains an environment`);
  }
  if (containsSecretReference(job.config)) {
    problems.push(`${path}#${job.id} contains repository/environment secrets`);
  }
  if (Object.hasOwn(job.config, "needs")) {
    problems.push(
      `${path}#${job.id} must not consume outputs from another job`,
    );
  }
  if (usesAction(job, "actions/download-artifact@")) {
    problems.push(`${path}#${job.id} must not download cross-job artifacts`);
  }
  if (
    isMapping(job.config.permissions) &&
    job.config.permissions.packages === "write"
  ) {
    problems.push(`${path}#${job.id} contains packages: write`);
  }
  if (usesAction(job, "docker/login-action@")) {
    problems.push(`${path}#${job.id} contains a registry login action`);
  }
  if (pushesImage(job)) {
    problems.push(`${path}#${job.id} contains an image push`);
  }
  if (
    job.id === "build" &&
    (path === ".github/workflows/docker-api.yml" ||
      path === ".github/workflows/docker-keycloak.yml") &&
    !buildsCanonicalImagePlatform(path, job)
  ) {
    problems.push(
      `${path}#${job.id} must load and smoke-test the published linux/amd64 platform`,
    );
  }
  return problems;
}

function hostedJobProblems(path, job, mode) {
  const problems = [];
  if (job.config["runs-on"] !== "ubuntu-latest") {
    problems.push(`${path}#${job.id} must remain on ubuntu-latest`);
  }
  if (JSON.stringify(job.config).includes("osf-pr")) {
    problems.push(`${path}#${job.id} must never reference osf-pr`);
  }

  if (mode === "publish") {
    if (job.config.if !== PUBLISH_IF) {
      problems.push(
        `${path}#${job.id} must use the canonical main/v* publish condition`,
      );
    }
    if (
      !isMapping(job.config.permissions) ||
      job.config.permissions.packages !== "write"
    ) {
      problems.push(
        `${path}#${job.id} must own the isolated packages: write permission`,
      );
    }
    if (!usesAction(job, "docker/login-action@") || !pushesImage(job)) {
      problems.push(
        `${path}#${job.id} must contain the isolated registry login and push steps`,
      );
    }
  }

  return problems;
}

export function auditWorkflowSources(workflows) {
  const workflowPaths = Object.keys(workflows).sort();
  const problems = [];
  let routed = 0;
  let hosted = 0;

  for (const path of workflowPaths) {
    const source = workflows[path];
    const policy = JOB_POLICY[path];
    if (!policy) {
      problems.push(`${path} has no workflow runner security policy`);
      continue;
    }
    const parsed = parseWorkflow(path, source, problems);
    if (!parsed) continue;
    const { workflow, jobs } = parsed;
    const routedJobs = jobs.filter(
      (job) => Object.hasOwn(policy, job.id) && policy[job.id] === "routed",
    );

    if (routedJobs.length > 0) {
      if (!hasOnlyReadContents(workflow.permissions)) {
        problems.push(
          `${path} has routed jobs but workflow permissions are not exactly contents: read`,
        );
      }
      const workflowScope = { ...workflow };
      delete workflowScope.jobs;
      if (containsSecretReference(workflowScope)) {
        problems.push(
          `${path} exposes a workflow-level secret reference to routed jobs`,
        );
      }
    }

    for (const job of jobs) {
      if (!Object.hasOwn(policy, job.id)) {
        problems.push(
          `${path}#${job.id} has no explicit runner security policy`,
        );
        continue;
      }
      const mode = policy[job.id];
      if (mode === "routed") {
        routed += 1;
        problems.push(...routedJobProblems(path, workflow, job));
      } else {
        hosted += 1;
        problems.push(...hostedJobProblems(path, job, mode));
      }
    }

    for (const expected of Object.keys(policy)) {
      if (!jobs.some((job) => job.id === expected)) {
        problems.push(`${path} is missing policy-listed job ${expected}`);
      }
    }

    if (
      path === ".github/workflows/ci.yml" &&
      !jobs.some(
        (job) =>
          job.id === "gates" &&
          stepsFor(job).some(
            (step) =>
              isMapping(step) &&
              step.run === "bun run check:self-hosted-routing",
          ),
      )
    ) {
      problems.push(
        `${path}#gates must invoke check:self-hosted-routing inside the existing required check`,
      );
    }
  }

  for (const path of Object.keys(JOB_POLICY)) {
    if (!workflowPaths.includes(path)) {
      problems.push(`${path} is listed in runner policy but does not exist`);
    }
  }

  return { problems, routed, hosted };
}

async function main() {
  const files = (await readdir(join(REPO_ROOT, WORKFLOW_DIR)))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  const workflows = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const path = join(WORKFLOW_DIR, file);
        return [path, await readFile(join(REPO_ROOT, path), "utf8")];
      }),
    ),
  );
  const { problems, routed, hosted } = auditWorkflowSources(workflows);

  if (problems.length > 0) {
    console.error(
      `Self-hosted runner routing policy failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    process.exit(1);
  }

  console.log(
    `Self-hosted runner routing is fail-closed: ${routed} trusted-source PR jobs route to osf-pr; ${hosted} sensitive/fallback jobs remain GitHub-hosted.`,
  );
}

if (import.meta.main) await main();
