#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const DEFAULT_BASELINE_PATH = "config/ts-nocheck-baseline.json";
export const DEFAULT_SCAN_ROOTS = [
  "packages/compiler/src",
  "examples/plugins/workflow/src",
];

const TS_NOCHECK_DIRECTIVE = /^\s*\/\/\s*@ts-nocheck\b/m;

async function listTypeScriptFiles(repoRoot, current = repoRoot) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(repoRoot, fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relative(repoRoot, fullPath));
    }
  }
  return files;
}

export async function collectTsNoCheckFiles(repoRoot, roots = DEFAULT_SCAN_ROOTS) {
  const candidates = (await Promise.all(
    roots.map((root) => listTypeScriptFiles(repoRoot, join(repoRoot, root))),
  )).flat();
  const files = [];
  for (const file of [...new Set(candidates)].sort()) {
    const source = await readFile(join(repoRoot, file), "utf8");
    if (TS_NOCHECK_DIRECTIVE.test(source)) files.push(file);
  }
  return files;
}

async function readBaseline(repoRoot, baselinePath) {
  const parsed = JSON.parse(await readFile(join(repoRoot, baselinePath), "utf8"));
  if (
    parsed === null || typeof parsed !== "object" || parsed.version !== 1 ||
    !Array.isArray(parsed.files) || parsed.files.some((file) => typeof file !== "string")
  ) {
    throw new Error(`${baselinePath} must contain {"version": 1, "files": string[]}.`);
  }
  const files = [...parsed.files].sort();
  if (new Set(files).size !== files.length) {
    throw new Error(`${baselinePath} must not contain duplicate file paths.`);
  }
  if (files.some((file, index) => file !== parsed.files[index])) {
    throw new Error(`${baselinePath} files must be sorted for deterministic review.`);
  }
  return files;
}

export async function checkTsNoCheckBaseline({
  repoRoot = process.cwd(),
  roots = DEFAULT_SCAN_ROOTS,
  baselinePath = DEFAULT_BASELINE_PATH,
} = {}) {
  const [actual, baseline] = await Promise.all([
    collectTsNoCheckFiles(repoRoot, roots),
    readBaseline(repoRoot, baselinePath),
  ]);
  const baselineSet = new Set(baseline);
  const actualSet = new Set(actual);
  const added = actual.filter((file) => !baselineSet.has(file));
  const removed = baseline.filter((file) => !actualSet.has(file));
  if (added.length > 0 || removed.length > 0) {
    const lines = [`${baselinePath} does not match the current @ts-nocheck directives.`];
    if (added.length > 0) {
      lines.push("New directives not in the baseline:", ...added.map((file) => `- ${file}`));
    }
    if (removed.length > 0) {
      lines.push(
        "Baseline entries with no current directive (remove them from the baseline):",
        ...removed.map((file) => `- ${file}`),
      );
    }
    throw new Error(lines.join("\n"));
  }
  return { actual, baseline, added, removed };
}

if (import.meta.main) {
  const result = await checkTsNoCheckBaseline();
  console.log(
    `@ts-nocheck baseline is unchanged (${result.actual.length} files; ` +
      "remove a directive and its baseline entry together as typechecking is restored).",
  );
}
