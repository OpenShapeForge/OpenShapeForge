#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// The branch-protection ruleset names the CI jobs it requires as literal
// strings (scripts/github/protect-main.ruleset.json). GitHub matches a required
// status check BY NAME, and a name that matches no job is simply never
// reported — the check sits pending forever, or, once removed from the
// ruleset's view, stops being enforced at all. Either way the failure is
// silent: renaming a job in .github/workflows/** would quietly drop a gate that
// the ruleset still claims to enforce.
//
// This closes that loop: every required context must correspond to exactly one
// job name across the workflows that run on pull requests.
//
// It also checks the TRIGGER, not just the name (issue #269). A workflow whose
// `pull_request:` carries a `branches:` filter runs on some pull requests and
// not others, and the ones it skips report no check at all — `gh pr checks`
// answers "no checks reported", which reads as pending rather than as
// never-going-to-run. That is the same silent failure by a different route, and
// it is how stacked pull requests (#240 slices the designer work into a stack)
// went entirely ungated. A required check must therefore run on EVERY pull
// request.
//
// And it checks that a required job which only reports the result of others
// (`needs:`) cannot be skipped into passing: GitHub counts a skipped required
// check as satisfied, so such a job must run `if: always()` and fail itself.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULESET_PATH = "scripts/github/protect-main.ruleset.json";
const WORKFLOW_DIR = ".github/workflows";
// These are security boundaries whose workflow and ruleset entry must not be
// deleted together. A two-way name comparison cannot detect that coordinated
// omission because both sides still agree on the smaller set.
const SECURITY_CRITICAL_REQUIRED_CONTEXTS = [
  "API e2e (GraphQL, REST, MCP)",
  "Browser e2e (apps/web)",
];

/**
 * Job names from a workflow file, whether it runs on pull_request, and whether
 * that trigger is restricted to particular base branches.
 *
 * Deliberately dependency-free rather than a YAML parser: this runs in the
 * checks job, and the shapes it reads (a `name:` two levels in, a top-level
 * `on:` block) are stable and already linted by GitHub itself. Line-scanned
 * rather than regex-matched across the whole file because the base filter is
 * only meaningful in its position — a `branches:` under `push:` says nothing
 * about pull requests.
 *
 * @returns {{ runsOnPullRequest: boolean, pullRequestBaseFilter: string | null,
 *             jobs: { name: string, needs: boolean, condition: string | null }[] }}
 */
function parseWorkflow(source) {
  let runsOnPullRequest = false;
  let pullRequestBaseFilter = null;
  let inOnBlock = false;
  let inPullRequest = false;

  for (const line of source.split("\n")) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (/^on:\s*$/.test(line)) {
      inOnBlock = true;
      continue;
    }
    if (!inOnBlock) continue;
    if (/^\S/.test(line)) {
      // A new top-level key ends the `on:` block.
      inOnBlock = false;
      inPullRequest = false;
    } else if (/^ {2}pull_request:/.test(line)) {
      runsOnPullRequest = true;
      inPullRequest = true;
    } else if (/^ {2}\S/.test(line)) {
      inPullRequest = false; // a sibling event: push, workflow_dispatch, ...
    } else if (inPullRequest) {
      const filter = line.match(/^ {4}(branches(?:-ignore)?):/);
      if (filter) pullRequestBaseFilter = filter[1];
    }
  }

  // A job is a two-space key under `jobs:`; its name, needs and condition are
  // keys four spaces in.
  const jobs = [];
  const jobsIndex = source.search(/^jobs:\s*$/m);
  if (jobsIndex !== -1) {
    let job = null;
    for (const line of source.slice(jobsIndex).split("\n").slice(1)) {
      if (/^\s*#/.test(line)) continue;
      if (/^\S/.test(line)) break;
      if (/^ {2}[\w-]+:\s*$/.test(line)) {
        job = { name: null, needs: false, condition: null };
        jobs.push(job);
        continue;
      }
      const key = line.match(/^ {4}(name|needs|if):\s*(.*?)\s*$/);
      if (!job || !key) continue;
      if (key[1] === "name") job.name = key[2].replace(/^["']|["']$/g, "");
      else if (key[1] === "needs") job.needs = true;
      else job.condition = key[2];
    }
  }
  return {
    runsOnPullRequest,
    pullRequestBaseFilter,
    jobs: jobs.filter((job) => job.name !== null),
  };
}

async function main() {
  const ruleset = JSON.parse(
    await readFile(join(REPO_ROOT, RULESET_PATH), "utf8"),
  );
  const rule = ruleset.rules?.find((r) => r.type === "required_status_checks");
  const required = (rule?.parameters?.required_status_checks ?? []).map(
    (check) => check.context,
  );

  if (required.length === 0) {
    console.error(
      `${RULESET_PATH} declares no required status checks — main would merge on review alone.`,
    );
    process.exit(1);
  }

  /**
   * @type {Map<string, { path: string, baseFilter: string | null,
   *                      needs: boolean, condition: string | null }[]>}
   * job name -> the pull-request workflows declaring it
   */
  const jobs = new Map();
  const files = (await readdir(join(REPO_ROOT, WORKFLOW_DIR)))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();

  for (const file of files) {
    const path = join(WORKFLOW_DIR, file);
    const { runsOnPullRequest, pullRequestBaseFilter, jobs: declared } =
      parseWorkflow(await readFile(join(REPO_ROOT, path), "utf8"));
    if (!runsOnPullRequest) continue; // never reports a check on a PR
    for (const { name, needs, condition } of declared) {
      jobs.set(name, [
        ...(jobs.get(name) ?? []),
        { path, baseFilter: pullRequestBaseFilter, needs, condition },
      ]);
    }
  }

  const problems = [];
  for (const context of SECURITY_CRITICAL_REQUIRED_CONTEXTS) {
    if (!required.includes(context)) {
      problems.push(
        `security-critical check "${context}" is absent from ${RULESET_PATH}`,
      );
    }
  }
  for (const context of required) {
    const declaredIn = jobs.get(context);
    if (!declaredIn) {
      problems.push(
        `required check "${context}" matches no job that runs on pull requests — it would stay pending forever`,
      );
      continue;
    }
    if (declaredIn.length > 1) {
      problems.push(
        `required check "${context}" is ambiguous: declared by ${declaredIn.length} jobs (${declaredIn.map((d) => d.path).join(", ")})`,
      );
      continue;
    }
    const [{ path, baseFilter, needs, condition }] = declaredIn;
    if (baseFilter) {
      problems.push(
        `required check "${context}" lives in ${path}, whose pull_request trigger carries a "${baseFilter}:" filter —` +
          ` it would report nothing on a pull request whose base is excluded, which reads as pending rather than as never running (#269)`,
      );
    }
    // A job with `needs:` is skipped when a dependency fails, and GitHub counts
    // a skipped required check as passed. Only `always()` makes it run — and
    // so fail — whatever its dependencies did.
    if (needs && !condition?.includes("always()")) {
      problems.push(
        `required check "${context}" in ${path} has needs: but no \`if: always()\` —` +
          ` a failed dependency would skip it, and a skipped required check passes`,
      );
    }
  }

  // The reverse direction is a warning, not a failure: a job may legitimately
  // run on PRs without gating the merge.
  const unrequired = [...jobs.keys()]
    .filter((name) => !required.includes(name))
    .sort();

  if (problems.length > 0) {
    console.error(
      `${RULESET_PATH} is out of sync with ${WORKFLOW_DIR}:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nRestore the job name, drop the pull_request base filter, add \`if: always()\`, or update` +
        ` the ruleset and re-run scripts/github/apply-branch-protection.sh.`,
    );
    process.exit(1);
  }

  console.log(
    `Branch protection requires ${required.length} status checks, each matching exactly one job that runs on every pull request.` +
      (unrequired.length > 0
        ? ` Not required (informational): ${unrequired.join(", ")}.`
        : ""),
  );
}

await main();
