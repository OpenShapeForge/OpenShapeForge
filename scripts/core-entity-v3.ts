// SPDX-License-Identifier: BUSL-1.1
/**
 * The coreEntity v3 gate: every authored entity is schemaVersion 3 with its
 * relationships on fields. The v1/v2 rewrite this file once carried is done;
 * the one-type-axis migration lives in scripts/migrate-one-type-axis/.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const requireCompiler = createRequire(new URL("../packages/compiler/package.json", import.meta.url));
export const yaml = requireCompiler("yaml");
export type EntityDocument = Record<string, any>;
export type CorpusEntry = { path: string; document: EntityDocument };

/** Track both checked-in and newly authored examples/fixtures, irrespective of directory naming. */
export function readYamlCorpus(root: string): CorpusEntry[] {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  return [...new Set(files.split("\0"))].filter(path => /\.ya?ml$/.test(path) && existsSync(join(root, path)))
    .sort().flatMap(path => {
      const source = readFileSync(join(root, path), "utf8");
      // Helm templates are not YAML until rendered. Never use that exception
      // for a source declaring an authoring coreEntity.
      if (path.includes("/templates/") && source.includes("{{-") && !source.includes("coreEntity")) return [];
      return yaml.parseAllDocuments(source).map(document => {
        if (document.errors.length) throw new Error(`${path}: ${document.errors[0]!.message}`);
        return { path, document: document.toJS() };
      });
    });
}

// No directory-wide legacy exemption: only genuine, individually documented
// legacy rejection fixtures may be added here. Production can never opt out.
export const LEGACY_REJECTION_FIXTURES: Readonly<Record<string, string>> = Object.freeze({});

export function checkCoreEntityV3(corpus: CorpusEntry[], exceptions = LEGACY_REJECTION_FIXTURES) {
  const failures: string[] = [];
  const entities = corpus.filter(entry => entry.document?.kind === "coreEntity");
  const isExempt = (path: string) => Object.hasOwn(exceptions, path) && path.includes("/__fixtures__/legacy-rejection/") && Boolean(exceptions[path]?.trim());
  for (const [path, reason] of Object.entries(exceptions)) {
    if (!path.includes("/__fixtures__/legacy-rejection/") || !reason.trim()) failures.push(`Invalid legacy rejection exemption: ${path}`);
    if (!entities.some(entry => entry.path === path && entry.document.schemaVersion !== 3)) failures.push(`Stale legacy rejection exemption: ${path}`);
  }
  for (const { path, document } of entities) {
    if (isExempt(path)) continue;
    if (document.schemaVersion !== 3) failures.push(`${path}: ${document.entity} uses schemaVersion ${document.schemaVersion}; require 3`);
    if (Object.hasOwn(document, "relationships")) failures.push(`${path}: ${document.entity} has legacy top-level relationships; use fields`);
  }
  return { total: entities.length, old: entities.filter(entry => entry.document.schemaVersion !== 3 && !isExempt(entry.path)).length, failures };
}
