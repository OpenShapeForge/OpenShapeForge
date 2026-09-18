#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
/**
 * One type axis: migrate every authoring YAML in a repository.
 *
 *   bun scripts/migrate-one-type-axis/cli.ts [--root <dir>]... [--write] [--strict]
 *                                            [--baseline-manifest <db manifest.json>]
 *
 * `--root` may be repeated: a base repository and the plugin repositories
 * that reference its entities are then one corpus, so a plugin field that
 * references a base entity is folded and inverse ambiguity is judged across
 * all of them. With one root, paths are relative to it; with several, absolute.
 *
 * Dry run by default: prints what would change and exits non-zero on any
 * error. `--write` rewrites the files. `--strict` refuses to create fields
 * for legacy belongsTo relationships that have none. `--include-seeds` also
 * renames inside seed/fixture files that are not compiler definitions (an
 * integration's own field definitions stay data otherwise). `--baseline-manifest`
 * points at the storage manifest the CURRENT compiler emitted, so a created
 * field's `required` follows that column's nullability rather than a guess.
 *
 *   bun scripts/migrate-one-type-axis/cli.ts --data < value.json > migrated.json
 *
 * `--data` rewrites one JSON value read from stdin (a stored fieldDefinition[]
 * column value, or a whole document such as a workflow definition version)
 * and writes the result to stdout; the report goes to stderr. See data.ts for
 * which columns hold such values.
 *
 * Idempotent: a migrated corpus or value produces no further changes.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCorpora, loadCorpus, renderFile } from "./corpus.ts";
import { rewriteFieldDefinitionJson } from "./data.ts";
import { type MigrationOptions, migrateCorpus } from "./migrate.ts";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentValues(name: string): string[] {
  return process.argv.flatMap((argument, index) => (argument === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []));
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

async function rewriteStdin(): Promise<void> {
  const input = await new Response(process.stdin).text();
  const { text, report } = rewriteFieldDefinitionJson(input);
  process.stdout.write(text);
  console.error(`osfType renamed: ${report.renamed}, derived from valueType: ${report.derivedFromValueType}, valueType dropped: ${report.valueTypesDropped}`);
}

function main(): void {
  if (process.argv.includes("--data")) {
    void rewriteStdin();
    return;
  }
  const roots = argumentValues("--root").map((root) => resolve(root));
  const root = roots[0] ?? resolve(join(import.meta.dir, "..", ".."));
  const write = process.argv.includes("--write");
  const manifestPath = argumentValue("--baseline-manifest");
  const corpus = roots.length > 1 ? loadCorpora(roots) : loadCorpus(root);
  const result = migrateCorpus(corpus, {
    strict: process.argv.includes("--strict"),
    includeSeeds: process.argv.includes("--include-seeds"),
    ...(manifestPath ? { columnRequired: columnRequiredFromManifest(resolve(root, manifestPath)) } : {}),
  });
  const { report } = result;
  for (const line of report.legacy.belongsToFolded) console.log(`belongsTo folded: ${line}`);
  for (const created of report.legacy.fieldsCreated) console.log(`field created: ${created.entity}.${created.key} (${created.column}, required: ${created.required}, ${created.provenance})`);
  for (const line of report.legacy.hasManyRemoved) console.log(`hasMany removed: ${line}`);
  for (const line of report.fold.collectionsFolded) console.log(`collection folded: ${line}`);
  for (const line of report.fold.ambiguityDeclared) console.log(`inverse: false declared: ${line}`);
  console.log(`osfType renamed: ${report.rename.renamed}, derived from valueType: ${report.rename.derivedFromValueType}, valueType dropped: ${report.rename.valueTypesDropped}`);
  for (const path of report.rename.skipped) console.log(`skipped (data, not a definition; --include-seeds to rename): ${path}`);
  for (const path of report.rename.catalogs) console.log(`type catalog: ${path}`);
  console.log(`files changed: ${result.changed.length}`);
  const errors = [...report.legacy.errors, ...report.fold.errors];
  for (const error of errors) console.error(`error: ${error}`);
  if (errors.length) process.exit(1);
  if (!write) {
    for (const file of result.changed) console.log(`  ${file.path}${file.renameTo ? ` -> ${file.renameTo}` : ""}`);
    return;
  }
  for (const file of result.changed) {
    const at = (path: string) => (corpus.shared ? path : join(root, path));
    writeFileSync(at(file.renameTo ?? file.path), renderFile(file));
    if (file.renameTo) unlinkSync(at(file.path));
  }
  console.log("written.");
}

if (import.meta.main) main();
