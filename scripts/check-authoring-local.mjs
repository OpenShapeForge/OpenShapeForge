#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadActivePlatformManifest } from "../packages/compiler/src/active-manifest.ts";
import { collectAllArtifacts } from "../packages/compiler/src/index.ts";

const repoRoot = process.cwd();
const schemasDir = join(repoRoot, "packages/compiler/config/schemas");

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath));
    }
  }
  return files.sort();
}

// Deliberately NOT a conformance check. This asserts the schema directory is
// present and parses; whether authoring MATCHES those schemas is a separate
// gate (`bun run check:authoring-schemas`, #182). The success line below says
// which, because the previous wording — "self-consistent (… , 14 schemas)" —
// read as schema conformance while only ever being a JSON.parse.
async function assertReadableJsonFiles(root, label) {
  const files = await listFiles(root);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));
  if (jsonFiles.length === 0) {
    throw new Error(`${label} has no JSON schema files.`);
  }
  for (const file of jsonFiles) {
    JSON.parse(await readFile(join(root, file), "utf8"));
  }
  return jsonFiles.length;
}

function hashArtifacts(artifacts) {
  const hasher = createHash("sha256");
  for (const artifact of artifacts.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hasher.update(artifact.path);
    hasher.update("\0");
    hasher.update(artifact.contents);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

const [first, second, schemaCount, manifest] = await Promise.all([
  collectAllArtifacts(repoRoot),
  collectAllArtifacts(repoRoot),
  assertReadableJsonFiles(schemasDir, "Compiler schema directory"),
  loadActivePlatformManifest(repoRoot),
]);

if (hashArtifacts(first.all) !== hashArtifacts(second.all)) {
  throw new Error("Artifact generation (core or plugins) is nondeterministic.");
}

if (!Array.isArray(manifest.tables) || manifest.tables.length === 0) {
  throw new Error("Active platform manifest has no tables.");
}

const pluginNote =
  first.groups.plugins.length > 0
    ? `, plugins: ${first.groups.plugins.map((entry) => entry.name).join(", ")}`
    : "";
console.log(
  `Local authoring catalog is self-consistent (${first.all.length} artifacts, ` +
    `${manifest.tables.length} tables${pluginNote}). ` +
    `${schemaCount} schema files parse; conformance is checked by check:authoring-schemas.`,
);
