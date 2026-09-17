#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
/**
 * One type axis: migrate every authoring YAML in a repository.
 *
 *   bun scripts/migrate-one-type-axis/cli.ts [--root <dir>] [--write] [--strict]
 *                                            [--baseline-manifest <db manifest.json>]
 *
 * Dry run by default: prints what would change and exits non-zero on any
 * error. `--write` rewrites the files. `--strict` refuses to create fields
 * for legacy belongsTo relationships that have none. `--baseline-manifest`
 * points at the storage manifest the CURRENT compiler emitted, so a created
 * field's `required` follows that column's nullability rather than a guess.
 *
 * Idempotent: a migrated corpus produces no further changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCorpus, renderFile } from "./corpus.ts";
import { type MigrationOptions, migrateCorpus } from "./migrate.ts";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function columnRequiredFromManifest(path: string): MigrationOptions["columnRequired"] {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    tables: { source?: { authoringEntityName?: string }; columns: { name: string; required?: boolean }[] }[];
  };
  const byEntity = new Map<string, Map<string, boolean>>();
  for (const table of manifest.tables) {
    const entity = table.source?.authoringEntityName;
    if (!entity) continue;
    byEntity.set(entity, new Map(table.columns.map((column) => [column.name, column.required === true])));
  }
  return (entity, column) => byEntity.get(entity)?.get(column);
}

function main(): void {
  const root = resolve(argumentValue("--root") ?? join(import.meta.dir, "..", ".."));
  const write = process.argv.includes("--write");
  const manifestPath = argumentValue("--baseline-manifest");
  const corpus = loadCorpus(root);
  const result = migrateCorpus(corpus, {
    strict: process.argv.includes("--strict"),
    ...(manifestPath ? { columnRequired: columnRequiredFromManifest(resolve(root, manifestPath)) } : {}),
  });
  const { report } = result;
  for (const line of report.legacy.belongsToFolded) console.log(`belongsTo folded: ${line}`);
  for (const created of report.legacy.fieldsCreated) console.log(`field created: ${created.entity}.${created.key} (${created.column}, required: ${created.required}, ${created.provenance})`);
  for (const line of report.legacy.hasManyRemoved) console.log(`hasMany removed: ${line}`);
  for (const line of report.fold.collectionsFolded) console.log(`collection folded: ${line}`);
  for (const line of report.fold.ambiguityDeclared) console.log(`inverse: false declared: ${line}`);
  console.log(`osfType renamed: ${report.rename.renamed}, derived from valueType: ${report.rename.derivedFromValueType}, valueType dropped: ${report.rename.valueTypesDropped}`);
  console.log(`files changed: ${result.changed.length}`);
  const errors = [...report.legacy.errors, ...report.fold.errors];
  for (const error of errors) console.error(`error: ${error}`);
  if (errors.length) process.exit(1);
  if (!write) {
    for (const file of result.changed) console.log(`  ${file.path}`);
    return;
  }
  for (const file of result.changed) writeFileSync(join(root, file.path), renderFile(file));
  console.log("written.");
}

if (import.meta.main) main();
