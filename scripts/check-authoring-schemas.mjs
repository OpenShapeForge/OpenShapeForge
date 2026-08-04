#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// Validates every authoring YAML in this repository against the JSON Schema for
// its `kind` (#182).
//
// The corpus half of the answer. "This repository's authoring" is every layer
// `authoring.config.yaml` resolves to — the configured layers AND the
// `authoring/` directory of each plugin it loads — taken from the resolver the
// compiler itself uses, so the two cannot disagree about which files that is.
// Naming one directory literally is what left the plugin-shipped layers checked
// by neither this gate nor the load-time path (#237). Authoring that arrives
// from OUTSIDE this repository — a connector contract shipped by a package, or
// a host repo's own layer — is validated at load instead (connector-loader.ts).
// Both call the same validator, so the two paths cannot disagree about what a
// schema means either.
//
// Every mapped schema also carries an expected file count. A schema that is
// present, mapped, and matched against nothing produced the same summary line
// as one matched against a full corpus — which is how workflow-node.schema.json
// dereferenced against zero files for as long as it did, in a gate reporting
// success. Counting per schema makes "this stopped matching anything" a
// failure rather than a smaller number nobody reads.
//
// Reports orphan schemas rather than failing on them: a schema no kind maps to
// and no other schema references is either documentation for something outside
// this repo or dead weight, and that is a judgement call, not a build error.

import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { authoringLayerDirs } from "../packages/compiler/src/authoring/layers.ts";
import {
  createAuthoringValidator,
  SCHEMA_BY_KIND,
  UNSCHEMAD_KINDS,
} from "../packages/compiler/src/authoring/schema-validation.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Authoring files each mapped schema is expected to validate, exactly.
 *
 * Adding authoring means bumping the entry here, the same way adding an entity
 * means bumping `expectedGeneratedCrudEntityCount` in
 * check-generated-artifacts.mjs. The cost is one number per change; what it
 * buys is that a schema cannot quietly stop covering its corpus — a renamed
 * layer root, a dropped plugin, a mistyped `kind` — while the gate keeps
 * reporting success.
 */
const EXPECTED_SCHEMA_COVERAGE = Object.freeze({
  "authorization-config.schema.json": 1,
  "connector.schema.json": 1,
  "core-entity.schema.json": 43,
  "retention-policy-catalog.schema.json": 1,
  "semantic-type-catalog.schema.json": 1,
  "transform-catalog.schema.json": 1,
  "workflow-node.schema.json": 44,
  // Zero on purpose: the compiler reads these kinds, but no layer in this
  // repository authors one today. Stated rather than inferred — an inferred
  // zero is indistinguishable from a corpus that went missing, which is the
  // whole failure this map exists to close.
  "entity-mapping.schema.json": 0,
  "entity-profile.schema.json": 0,
  "view.schema.json": 0,
});

/**
 * Layer roots that live in this repository's own tree. One resolved out of
 * node_modules is the "arrives from outside" case: it ships with its package,
 * nothing here can fix it, and it is validated at load.
 */
function isInRepoTree(dir) {
  const rel = relative(repoRoot, dir);
  return rel.length > 0 && !rel.startsWith("..") && !rel.split(sep).includes("node_modules");
}

function listYamlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listYamlFiles(path));
    else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) out.push(path);
  }
  return out.sort();
}

const scanRoots = [...new Set(authoringLayerDirs(repoRoot))].filter(isInRepoTree);

const validator = createAuthoringValidator();
const failures = [];
const validated = [];
const unschemad = new Map();

for (const root of scanRoots) {
  for (const file of listYamlFiles(root)) {
    const origin = relative(repoRoot, file);
    try {
      const { document, schema } = validator.validateFile(file, origin);
      if (schema) validated.push({ origin, schema });
      else unschemad.set(document.kind, [...(unschemad.get(document.kind) ?? []), origin]);
    } catch (error) {
      failures.push(error.message);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  console.error(
    `\n${failures.length} authoring file(s) do not match their schema. Either the ` +
      "authoring is wrong, or the schema has drifted from what the compiler " +
      "accepts — both are real, and #182 exists because neither was detectable.",
  );
  process.exit(1);
}

// --- Coverage: each mapped schema matched the corpus it is meant to ---------

const mappedSchemas = new Set(Object.values(SCHEMA_BY_KIND));
const coverageFailures = [
  ...[...mappedSchemas]
    .filter((schema) => !(schema in EXPECTED_SCHEMA_COVERAGE))
    .map((schema) => `${schema} is mapped by SCHEMA_BY_KIND but has no expected count here`),
  ...Object.keys(EXPECTED_SCHEMA_COVERAGE)
    .filter((schema) => !mappedSchemas.has(schema))
    .map((schema) => `${schema} has an expected count here but no authoring kind maps to it`),
].sort();

const actualCoverage = new Map();
for (const { schema } of validated) {
  actualCoverage.set(schema, (actualCoverage.get(schema) ?? 0) + 1);
}
for (const [schema, expected] of Object.entries(EXPECTED_SCHEMA_COVERAGE).sort()) {
  const actual = actualCoverage.get(schema) ?? 0;
  if (actual !== expected) {
    coverageFailures.push(`${schema} validated ${actual} file(s), expected ${expected}`);
  }
}

if (coverageFailures.length > 0) {
  console.error("Authoring schema coverage changed:");
  for (const failure of coverageFailures) console.error(`- ${failure}`);
  console.error(
    "\nIf the change is intended — authoring added or removed, a kind newly " +
      "mapped — update EXPECTED_SCHEMA_COVERAGE in this script. If it is not, a " +
      "layer root or a `kind` stopped matching what it used to, and a schema is " +
      "now dereferenced against fewer files than anyone means it to be.",
  );
  process.exit(1);
}

// --- Report -----------------------------------------------------------------

const skipped = [...unschemad.entries()]
  .map(([kind, origins]) => `${kind} (${origins.length}): ${UNSCHEMAD_KINDS[kind]}`)
  .sort();

console.log(
  `${validated.length} authoring file(s) validated against ${actualCoverage.size} ` +
    `of ${validator.schemaFiles.length} schemas, across ${scanRoots.length} layer root(s): ` +
    `${scanRoots.map((root) => relative(repoRoot, root)).join(", ")}.`,
);
console.log(
  `Per schema: ${Object.entries(EXPECTED_SCHEMA_COVERAGE)
    .sort()
    .map(([schema, count]) => `${schema.replace(/\.schema\.json$/, "")} (${count})`)
    .join(", ")}.`,
);
if (skipped.length > 0) {
  console.log(`No schema exists yet for: ${skipped.join("; ")}.`);
}
if (validator.orphanSchemas.length > 0) {
  console.log(
    `Unused schemas (no authoring kind, referenced by no other schema): ${validator.orphanSchemas.join(", ")}.`,
  );
}
