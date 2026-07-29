#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { generatedCrudDeniedEntitySlugs } from "../packages/compiler/src/active-manifest.ts";
import { collectAllArtifacts } from "../packages/compiler/src/index.ts";
import {
  compilerOwnedGeneratedFiles,
  compilerOwnedGeneratedRoots,
} from "./compiler-generated-artifact-paths.mjs";

const repoRoot = process.cwd();
const webPresent = existsSync(join(repoRoot, "apps/web"));
const expectedGeneratedCrudEntityCount = 4;

const first = await collectAllArtifacts(repoRoot);
const second = await collectAllArtifacts(repoRoot);

const artifacts = first.all;
const uiArtifacts = first.groups.ui;
const artifactPathSet = new Set(artifacts.map((artifact) => artifact.path));
const generatedCrudDeniedFileNames = new Set(
  [...generatedCrudDeniedEntitySlugs].map((slug) => slug.replace(/-/g, "")),
);

function hashArtifacts(artifactsToHash) {
  const hash = createHash("sha256");
  for (const artifact of artifactsToHash.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hash.update(artifact.path);
    hash.update("\0");
    hash.update(artifact.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

// --- Determinism, per artifact group (plugins individually) -----------------

const groupPairs = [
  ["database", first.groups.db, second.groups.db],
  ["MCP", first.groups.mcp, second.groups.mcp],
  ["connectors", first.groups.connectors, second.groups.connectors],
  ["referentiedata", first.groups.referentiedata, second.groups.referentiedata],
  ["authoring UI", first.groups.ui, second.groups.ui],
  ["Keycloak", first.groups.keycloak, second.groups.keycloak],
  ...first.groups.plugins.map((entry, index) => [
    `plugin ${entry.name}`,
    entry.artifacts,
    second.groups.plugins[index]?.artifacts ?? [],
  ]),
];
for (const [label, firstGroup, secondGroup] of groupPairs) {
  if (hashArtifacts(firstGroup) !== hashArtifacts(secondGroup)) {
    console.error(`Generated ${label} artifacts are nondeterministic.`);
    process.exit(1);
  }
}

// --- Stale check: disk must match a fresh in-memory generation --------------

const stale = [];
for (const artifact of artifacts) {
  const current = await readFile(join(repoRoot, artifact.path), "utf8").catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (current !== artifact.contents) {
    stale.push(artifact.path);
  }
}

// --- Temp-write proof: every artifact lands as exactly one file -------------

const tempDir = await mkdtemp(join(tmpdir(), "openshapeforge-generated-proof-"));
try {
  for (const artifact of artifacts) {
    const target = join(tempDir, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, artifact.contents);
  }
  const written = [];
  async function collect(root, current = root) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await collect(root, fullPath);
      } else if (entry.isFile()) {
        written.push(relative(root, fullPath));
      }
    }
  }
  await collect(tempDir);
  if (written.length !== artifacts.length) {
    console.error("Generated artifact temp-write proof produced an unexpected file count.");
    process.exit(1);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

// --- Coverage (web UI shards; skipped while apps/web is absent) -------------

async function listNames(root, options = {}) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => options.directories ? entry.isDirectory() : entry.isFile())
    .filter((entry) => options.suffix ? entry.name.endsWith(options.suffix) : true)
    .map((entry) => options.stripSuffix ? entry.name.slice(0, -options.stripSuffix.length) : entry.name)
    .sort();
}

function isGeneratedCrudEnabledFileName(name) {
  return !generatedCrudDeniedFileNames.has(name);
}

function actionFileName(artifactPath) {
  if (
    !artifactPath.startsWith("apps/web/src/actions/generated/") ||
    !artifactPath.endsWith(".ts") ||
    artifactPath.includes("/__tests__/")
  ) {
    return null;
  }
  return basename(artifactPath, ".ts");
}

function diffNames(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((name) => !actualSet.has(name)),
    added: actual.filter((name) => !expectedSet.has(name)),
  };
}

function reportNameDiff(label, diff) {
  if (diff.missing.length === 0 && diff.added.length === 0) {
    return;
  }
  console.error(`\n${label} coverage changed.`);
  if (diff.missing.length > 0) {
    console.error("Missing:");
    for (const name of diff.missing) console.error(`- ${name}`);
  }
  if (diff.added.length > 0) {
    console.error("Added:");
    for (const name of diff.added) console.error(`- ${name}`);
  }
}

const coverageFailures = [];
let uiEntitySummary = "web disabled (no apps/web)";
if (webPresent) {
  const generatedManifestNames = uiArtifacts
    .filter((artifact) => artifact.path.startsWith("apps/web/src/compiler/entity-manifests/"))
    .map((artifact) => basename(artifact.path, ".ts"))
    .filter(isGeneratedCrudEnabledFileName)
    .sort();
  const generatedActionNames = uiArtifacts
    .map((artifact) => actionFileName(artifact.path))
    .filter((name) => name && isGeneratedCrudEnabledFileName(name))
    .sort();

  const currentManifestNames = await listNames(
    join(repoRoot, "apps/web/src/compiler/entity-manifests"),
    { suffix: ".ts", stripSuffix: ".ts" },
  ).then((names) => names.filter(isGeneratedCrudEnabledFileName));
  const currentActionNames = await listNames(
    join(repoRoot, "apps/web/src/actions/generated"),
    { suffix: ".ts", stripSuffix: ".ts" },
  ).then((names) => names.filter(isGeneratedCrudEnabledFileName));

  for (const [label, names] of [
    ["generated manifest shard", generatedManifestNames],
    ["generated action shard", generatedActionNames],
    ["current manifest shard", currentManifestNames],
    ["current action shard", currentActionNames],
  ]) {
    if (names.length !== expectedGeneratedCrudEntityCount) {
      coverageFailures.push(`${label} count ${names.length} != ${expectedGeneratedCrudEntityCount}`);
    }
  }

  for (const [label, diff] of [
    ["Generated action/manifest parity", diffNames(generatedActionNames, generatedManifestNames)],
    ["Current manifest shard", diffNames(currentManifestNames, generatedManifestNames)],
    ["Current action shard", diffNames(currentActionNames, generatedActionNames)],
  ]) {
    if (diff.missing.length > 0 || diff.added.length > 0) {
      coverageFailures.push(`${label} names differ from compiler output`);
      reportNameDiff(label, diff);
    }
  }
  uiEntitySummary = `${generatedManifestNames.length} UI entities`;
}

// --- Orphan check over compiler- AND plugin-owned paths ---------------------

async function listRelativeFilePaths(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRelativeFilePaths(root, fullPath));
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath));
    }
  }
  return files.sort();
}

const ownedRoots = [...compilerOwnedGeneratedRoots, ...first.ownedPaths.roots];
const ownedFiles = [...compilerOwnedGeneratedFiles, ...first.ownedPaths.files];
const existingOwnedFiles = (
  await Promise.all([
    ...ownedRoots.map(async (root) => {
      const files = await listRelativeFilePaths(join(repoRoot, root));
      return files
        .filter((file) => !file.includes("__tests__/"))
        .map((file) => `${root}/${file}`);
    }),
    ...ownedFiles.map(async (rel) => {
      const abs = join(repoRoot, rel);
      try {
        await readFile(abs, "utf8");
        return [rel];
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    }),
  ])
)
  .flat()
  .sort();
const orphanGeneratedFiles = existingOwnedFiles.filter((path) => !artifactPathSet.has(path));
if (orphanGeneratedFiles.length > 0) {
  coverageFailures.push("compiler-owned generated roots contain orphan files");
  console.error("\nCompiler-owned generated roots contain orphan files:");
  for (const path of orphanGeneratedFiles) {
    console.error(`- ${path}`);
  }
}

if (coverageFailures.length > 0) {
  console.error("\nGenerated entity coverage check failed:");
  for (const failure of coverageFailures) console.error(`- ${failure}`);
  process.exit(1);
}

if (stale.length > 0) {
  console.error("Generated artifacts are stale:");
  for (const path of stale) {
    console.error(`- ${path}`);
  }
  console.error("Run `bun run generate` and include the generated changes.");
  process.exit(1);
}

const pluginNote =
  first.groups.plugins.length > 0
    ? `, plugins: ${first.groups.plugins
        .map((entry) => `${entry.name} (${entry.artifacts.length})`)
        .join(", ")}`
    : "";
console.log(
  `Generated artifacts are fresh and deterministic (${first.groups.db.length} DB artifacts, ` +
    `${uiEntitySummary}${pluginNote}).`,
);
