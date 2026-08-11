#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// A repository-scoped self-hosted runner executes the checked-out pull-request
// code on infrastructure we own. That is acceptable only for branches in this
// repository. Fork pull requests, release/publication jobs, deployments, and
// jobs with repository secrets must stay on GitHub-hosted runners.
//
// Keep this check dependency-free. It runs inside the existing required gates
// job so it adds no GitHub-hosted PR check that could remain red during a
// hosted-Actions billing outage.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";

const TRUSTED_SOURCE_RUNS_ON =
  "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && 'osf-pr' || 'ubuntu-latest' }}";
const PUBLISH_IF =
  "${{ github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')) }}";
// Reject the context itself, not a list of access syntaxes. GitHub expressions
// also allow dynamic indexes and object serialization (`secrets[env.NAME]`,
// `toJSON(secrets)`), so enumerating dot/bracket forms would fail open.
const SECRET_REFERENCE =
  /\$\{\{(?:(?!\}\})[\s\S])*\bsecrets\b(?:(?!\}\})[\s\S])*\}\}/;

/**
 * Every workflow job is inventoried deliberately. Adding a job without making
 * an explicit runner/security choice fails this check.
 *
 * routed: same-repository PR -> osf-pr; fork PR and every non-PR -> hosted.
 * hosted: never use osf-pr.
 * publish: hosted plus the fail-closed main/v* publication condition.
 */
const JOB_POLICY = {
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
  ".github/workflows/web-e2e.yml": {
    "browser-e2e": "routed",
  },
};

function hasPullRequestTrigger(source) {
  let inOn = false;
  for (const line of source.split("\n")) {
    if (/^on:\s*$/.test(line)) {
      inOn = true;
      continue;
    }
    if (!inOn || /^\s*#/.test(line) || line.trim() === "") continue;
    if (/^\S/.test(line)) return false;
    if (/^ {2}pull_request:\s*(?:#.*)?$/.test(line)) return true;
  }
  return false;
}

function parseJobs(source) {
  const lines = source.split("\n");
  const jobs = [];
  const jobsLine = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsLine === -1) return jobs;

  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (!match) continue;

    let end = index + 1;
    while (
      end < lines.length &&
      !/^ {2}[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(lines[end]) &&
      !/^\S/.test(lines[end])
    ) {
      end += 1;
    }

    const block = lines.slice(index, end).join("\n");
    const property = (name) =>
      block.match(new RegExp(`^ {4}${name}:\\s*(.+?)\\s*$`, "m"))?.[1] ??
      null;
    jobs.push({
      id: match[1],
      block,
      name: property("name"),
      runsOn: property("runs-on"),
      condition: property("if"),
    });
    index = end - 1;
  }
  return jobs;
}

function permissionSpec(source, indent) {
  const lines = source.split("\n");
  const prefix = " ".repeat(indent);
  const entryPrefix = " ".repeat(indent + 2);
  const linePattern = new RegExp(
    `^${prefix}permissions:\\s*([^#\\s]+)?\\s*(?:#.*)?$`,
  );
  const start = lines.findIndex((line) => linePattern.test(line));
  if (start === -1) return null;
  const scalar = lines[start].match(linePattern)?.[1] ?? null;
  if (scalar) return { scalar, entries: [] };

  const entries = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!line.startsWith(entryPrefix)) break;
    const match = line.match(
      new RegExp(`^${entryPrefix}([A-Za-z-]+):\\s*([^#\\s]+)`),
    );
    if (match) entries.push([match[1], match[2]]);
  }
  return { scalar: null, entries };
}

function hasOnlyReadContents(spec) {
  return (
    spec?.scalar === null &&
    spec.entries.length === 1 &&
    spec.entries[0][0] === "contents" &&
    spec.entries[0][1] === "read"
  );
}

function routedJobHasOnlyReadContents(source, job) {
  const jobPermissions = permissionSpec(job.block, 4);
  if (jobPermissions) return hasOnlyReadContents(jobPermissions);
  const beforeJobs = source.split(/^jobs:\s*$/m)[0];
  return hasOnlyReadContents(permissionSpec(beforeJobs, 0));
}

function executableYaml(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function routedJobProblems(path, source, job) {
  const problems = [];
  if (!hasPullRequestTrigger(source)) {
    problems.push(`${path}#${job.id} is routed but its workflow has no pull_request trigger`);
  }
  if (job.runsOn !== TRUSTED_SOURCE_RUNS_ON) {
    problems.push(
      `${path}#${job.id} must use the canonical trusted-source runs-on expression`,
    );
  }
  if (!routedJobHasOnlyReadContents(source, job)) {
    problems.push(
      `${path}#${job.id} must have exactly contents: read permissions`,
    );
  }

  const forbidden = [
    [/^ {4}environment:/m, "an environment"],
    [SECRET_REFERENCE, "repository/environment secrets"],
    [/^ {6}packages:\s*write/m, "packages: write"],
    [/docker\/login-action@/, "a registry login action"],
    [/^\s+push:\s*true\s*$/m, "an image push"],
  ];
  for (const [pattern, description] of forbidden) {
    if (pattern.test(executableYaml(job.block))) {
      problems.push(`${path}#${job.id} contains ${description}`);
    }
  }
  return problems;
}

function hostedJobProblems(path, job, mode) {
  const problems = [];
  if (job.runsOn !== "ubuntu-latest") {
    problems.push(`${path}#${job.id} must remain on ubuntu-latest`);
  }
  if (job.block.includes("osf-pr")) {
    problems.push(`${path}#${job.id} must never reference osf-pr`);
  }

  if (mode === "publish") {
    if (job.condition !== PUBLISH_IF) {
      problems.push(`${path}#${job.id} must use the canonical main/v* publish condition`);
    }
    if (!/^ {6}packages:\s*write\s*(?:#.*)?$/m.test(job.block)) {
      problems.push(`${path}#${job.id} must own the isolated packages: write permission`);
    }
    if (!/docker\/login-action@/.test(job.block) || !/^\s+push:\s*true\s*$/m.test(job.block)) {
      problems.push(`${path}#${job.id} must contain the isolated registry login and push steps`);
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
    const jobs = parseJobs(source);
    const policy = JOB_POLICY[path] ?? {};
    const routedJobs = jobs.filter((job) => policy[job.id] === "routed");

    if (routedJobs.length > 0) {
      const workflowScope = source.split(/^jobs:\s*$/m)[0];
      if (!hasOnlyReadContents(permissionSpec(workflowScope, 0))) {
        problems.push(
          `${path} has routed jobs but workflow permissions are not exactly contents: read`,
        );
      }
      if (SECRET_REFERENCE.test(executableYaml(workflowScope))) {
        problems.push(
          `${path} exposes a workflow-level secret reference to routed jobs`,
        );
      }
    }

    for (const job of jobs) {
      const mode = policy[job.id];
      if (!mode) {
        problems.push(`${path}#${job.id} has no explicit runner security policy`);
        continue;
      }
      if (mode === "routed") {
        routed += 1;
        problems.push(...routedJobProblems(path, source, job));
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
          /run:\s*bun run check:self-hosted-routing\s*$/m.test(job.block),
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
