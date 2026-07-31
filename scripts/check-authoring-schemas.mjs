#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
//
// Validates every authoring YAML in this repository against the JSON Schema for
// its `kind` (#182).
//
// The corpus half of the answer. Authoring that originates here is checked in
// CI; authoring that arrives from OUTSIDE this repository — a connector
// contract shipped by a package, or a host repo's own layer — cannot be, so
// that is validated at load instead (connector-loader.ts). Both call the same
// validator, so the two paths cannot disagree about what a schema means.
//
// Reports orphan schemas rather than failing on them: a schema no kind maps to
// and no other schema references is either documentation for something outside
// this repo or dead weight, and that is a judgement call, not a build error.

import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuthoringValidator,
  UNSCHEMAD_KINDS,
} from "../packages/compiler/src/authoring/schema-validation.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const authoringDir = join(repoRoot, "packages/compiler/config/authoring");

function listYamlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listYamlFiles(path));
    else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) out.push(path);
  }
  return out.sort();
}

const validator = createAuthoringValidator();
const files = listYamlFiles(authoringDir);
const failures = [];
const validated = [];
const unschemad = new Map();

for (const file of files) {
  const origin = relative(repoRoot, file);
  try {
    const { document, schema } = validator.validateFile(file, origin);
    if (schema) validated.push({ origin, schema });
    else unschemad.set(document.kind, [...(unschemad.get(document.kind) ?? []), origin]);
  } catch (error) {
    failures.push(error.message);
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

if (validated.length === 0) {
  console.error(
    `No authoring file under ${relative(repoRoot, authoringDir)} mapped to a schema. ` +
      "A gate that validates nothing passes for the wrong reason.",
  );
  process.exit(1);
}

const skipped = [...unschemad.entries()]
  .map(([kind, origins]) => `${kind} (${origins.length}): ${UNSCHEMAD_KINDS[kind]}`)
  .sort();

console.log(
  `${validated.length} authoring file(s) validated against ${new Set(validated.map((v) => v.schema)).size} ` +
    `of ${validator.schemaFiles.length} schemas.`,
);
if (skipped.length > 0) {
  console.log(`No schema exists yet for: ${skipped.join("; ")}.`);
}
if (validator.orphanSchemas.length > 0) {
  console.log(
    `Unused schemas (no authoring kind, referenced by no other schema): ${validator.orphanSchemas.join(", ")}.`,
  );
}
