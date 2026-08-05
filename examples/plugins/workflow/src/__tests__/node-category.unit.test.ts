// SPDX-License-Identifier: BUSL-1.1
/**
 * How the standard catalog reads `category`.
 *
 * `category` is a locale map since #260, like `label` and `description` beside
 * it, so the palette heading it becomes can follow the reader. The compiler is
 * the ONLY place that also accepts the bare string the field used to be: every
 * pack in this repository authors a map, so the coercion has no user here and
 * would otherwise be untested code shipped for a host repo it was written for.
 *
 * That is what makes these tests worth their length — they are the only thing
 * standing between "a pack outside this repository still compiles" and nobody
 * noticing when it stops.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/src/__tests__/node-category.unit.test.ts 2>&1
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWorkflowNodeConfigArtifacts } from "../workflow-node-config.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An authoring layer holding one node file and nothing else. The semantic-type
 * enrichment the generator also runs tolerates an absent `catalogs/`, so a
 * category test does not have to assemble a whole authoring tree.
 */
function authoringDirWith(nodeYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "osf-node-category-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "workflow-nodes", "flow"), { recursive: true });
  writeFileSync(join(dir, "workflow-nodes", "flow", "sample.yaml"), nodeYaml);
  return dir;
}

function seedEntries(nodeYaml: string): Array<Record<string, unknown>> {
  const artifacts = generateWorkflowNodeConfigArtifacts(authoringDirWith(nodeYaml));
  const seed = artifacts.get("api/workflow/node-catalog.seed.json");
  if (seed === undefined) throw new Error("no node-catalog.seed.json was emitted");
  return (JSON.parse(seed) as { entries: Array<Record<string, unknown>> }).entries;
}

const WITH_MAP = [
  "schemaVersion: 1",
  "kind: workflowNode",
  "nodeType: sample",
  "category:",
  "  en: Flow",
  "  nl: Stroom",
  "label:",
  "  en: Sample",
  "configFields: []",
  "",
].join("\n");

const WITH_BARE_STRING = [
  "schemaVersion: 1",
  "kind: workflowNode",
  "nodeType: sample",
  "category: flow",
  "label:",
  "  en: Sample",
  "configFields: []",
  "",
].join("\n");

describe("category in the standard node catalog", () => {
  test("a locale map reaches the seed whole", () => {
    expect(seedEntries(WITH_MAP)[0]?.category).toEqual({ en: "Flow", nl: "Stroom" });
  });

  test("a bare string still compiles, and is read as English", () => {
    // The backwards-compatibility promise. `category` was a bare string until
    // #260, and a host repo's pack written against that must not stop building
    // on a widening that only ever adds information. `{ en: … }` is what the
    // palette already assumed of it — it capitalised the word and showed it
    // untranslated — so this reading loses nothing that was ever there.
    expect(seedEntries(WITH_BARE_STRING)[0]?.category).toEqual({ en: "flow" });
  });

  test("the coercion happens once, at the authoring boundary", () => {
    // Everything downstream — the seed, the jsonb column, the GraphQL type,
    // the palette — is handed a locale map and never a union, so no reader has
    // to know both shapes existed.
    const artifacts = generateWorkflowNodeConfigArtifacts(authoringDirWith(WITH_BARE_STRING));
    expect(artifacts.get("api/workflow/node-catalog.ts")).toContain(
      "category: Record<string, string>;",
    );
    expect(artifacts.get("workflow/generated/workflow-nodes.generated.ts")).toContain(
      "category: LocalizedText;",
    );
  });

  test("a missing category is refused, naming the file and the node type", () => {
    const yaml = WITH_MAP.replace("category:\n  en: Flow\n  nl: Stroom\n", "");
    expect(() => seedEntries(yaml)).toThrow(/sample\.yaml \(sample\) is missing a non-empty "category"/);
  });

  test("an empty string is refused rather than coerced to an empty heading", () => {
    // `{ en: "" }` is a category with no name, which the palette would render
    // as a blank heading rather than reporting. A generation-time error names
    // the file instead.
    expect(() => seedEntries(WITH_BARE_STRING.replace("category: flow", 'category: ""'))).toThrow(
      /is missing a non-empty "category"/,
    );
  });

  test("a locale map whose values are not strings is refused", () => {
    const yaml = WITH_MAP.replace("  nl: Stroom", "  nl: 42");
    expect(() => seedEntries(yaml)).toThrow(/is missing a non-empty "category"/);
  });
});
