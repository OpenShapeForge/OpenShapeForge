#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createAuthoringValidator } from "../packages/compiler/src/authoring/schema-validation";
import { planCoreEntityMigration, planMetadataRestoration, readYamlCorpus, yaml } from "./core-entity-v3";

// Dry run unless explicitly requested. Never rewrites already-v3/main-owned files.
const root = resolve(import.meta.dir, "..");
const corpus = readYamlCorpus(root);
const semanticTypes = corpus.find(entry => entry.document?.kind === "semanticTypeCatalog")?.document.types ?? {};
const plan = process.argv.includes("--restore-interfaces")
  ? { planned: planMetadataRestoration(root, corpus), blockers: [] }
  : planCoreEntityMigration(corpus, semanticTypes);
const validator = createAuthoringValidator();
for (const entry of plan.planned) {
  try { validator.validate(entry.document, entry.path); }
  catch (error) {
    // Negative fixtures may remain negative for their ORIGINAL invariant,
    // but migration must not introduce another schema failure.
    const original = corpus.find(item => item.path === entry.path)!.document;
    let originalFailure: string | undefined;
    try { validator.validate(original, entry.path); } catch (oldError) { originalFailure = (oldError as Error).message; }
    if (!entry.path.includes("/__fixtures__/") || originalFailure !== (error as Error).message) throw error;
  }
}
if (process.argv.includes("--write")) {
  for (const entry of plan.planned) {
    const path = join(root, entry.path);
    const old = yaml.parseDocument(readFileSync(path, "utf8"));
    const original = old.toJS();
    const expected = corpus.find(item => item.path === entry.path)!.document;
    if (JSON.stringify(original) !== JSON.stringify(expected)) throw new Error(`Concurrent edit: ${entry.path}`);
    // Preserve unchanged top-level nodes/comments; change only migrated sections.
    for (const key of Object.keys(original)) if (!Object.hasOwn(entry.document, key)) old.delete(key);
    for (const [key, value] of Object.entries(entry.document)) if (JSON.stringify(value) !== JSON.stringify(original[key])) old.set(key, value);
    writeFileSync(path, old.toString({ lineWidth: 120 }));
  }
}
console.log(JSON.stringify({ written: process.argv.includes("--write"), ready: plan.planned.map(entry => entry.path), blockers: plan.blockers }, null, 2));
