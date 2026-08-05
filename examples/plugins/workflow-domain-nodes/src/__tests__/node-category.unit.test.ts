// SPDX-License-Identifier: BUSL-1.1
/**
 * How the domain catalog reads `category`.
 *
 * These packs are where an untranslatable palette heading was first visible:
 * five categories were authored in Dutch — `Datum`, `Facturatie`, `Identiteit`,
 * `Vragenlijst`, `Zaak` — and there was no key to put an English spelling
 * under. #260 made the field a locale map, and this generator reads it the same
 * way the standard one does, including the bare string it used to be.
 *
 * The reading is duplicated between the two generators rather than shared,
 * because the two are deliberately separate — see the boundary note in
 * `domain-node-catalog.ts`. Two copies of a rule is two things that can drift,
 * so both are pinned.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow-domain-nodes/src/__tests__/node-category.unit.test.ts 2>&1
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOMAIN_NODE_CATALOG_SEED_FILE,
  generateDomainNodeCatalogArtifacts,
} from "../domain-node-catalog.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authoringDirWith(nodeYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "osf-domain-category-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "domain-workflow-nodes", "billing"), { recursive: true });
  writeFileSync(join(dir, "domain-workflow-nodes", "billing", "sample.yaml"), nodeYaml);
  return dir;
}

function seedEntries(nodeYaml: string): Array<Record<string, unknown>> {
  const artifacts = generateDomainNodeCatalogArtifacts(authoringDirWith(nodeYaml));
  const seed = artifacts.get(DOMAIN_NODE_CATALOG_SEED_FILE);
  if (seed === undefined) throw new Error(`no ${DOMAIN_NODE_CATALOG_SEED_FILE} was emitted`);
  return (JSON.parse(seed) as { entries: Array<Record<string, unknown>> }).entries;
}

const WITH_MAP = [
  "schemaVersion: 1",
  "kind: workflowNode",
  "nodeType: billing.sample",
  "category:",
  "  en: Billing",
  "  nl: Facturatie",
  "label:",
  "  en: Sample",
  "configFields: []",
  "",
].join("\n");

describe("category in the domain node catalog", () => {
  test("a locale map reaches the seed whole, both locales", () => {
    // The `nl` value is the word the pack shipped before #260, when it was the
    // only spelling and every English reader got it.
    expect(seedEntries(WITH_MAP)[0]?.category).toEqual({ en: "Billing", nl: "Facturatie" });
  });

  test("a bare string still compiles, and is read as English", () => {
    const yaml = WITH_MAP.replace("category:\n  en: Billing\n  nl: Facturatie", "category: billing");
    expect(seedEntries(yaml)[0]?.category).toEqual({ en: "billing" });
  });

  test("a missing category is refused, naming the file and the node type", () => {
    const yaml = WITH_MAP.replace("category:\n  en: Billing\n  nl: Facturatie\n", "");
    expect(() => seedEntries(yaml)).toThrow(
      /sample\.yaml \(billing\.sample\) is missing a non-empty "category"/,
    );
  });
});
