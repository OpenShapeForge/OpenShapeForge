import { expect, test } from "bun:test";
import { join } from "node:path";
import { compile } from "./compiler/index.js";
import { loadEntity } from "./loader.js";
import { buildWebManifest } from "./web-manifest.js";
const dir = join(import.meta.dir, "../../config/authoring");
const entries = () => ["budget", "budget-line", "ledger-account", "fiscal-period", "fiscal-year", "cost-dimension"].map(slug => ({
  slug, path: `entities/core/${slug}.yaml`, origin: "core" as const, contract: compile(loadEntity(dir, slug)),
}));
test("Budget uses the derived inverse collection and target-owned matrix under main", () => {
  const manifest = buildWebManifest(entries());
  expect(manifest.entities.Budget!.views.record!.preset).toBe("main");
  expect(manifest.entities.Budget!.views.record!.layout.tabs[0]).toMatchObject({ relationshipId: "budgetLines", targetView: "matrix" });
  expect(manifest.entities.Budget!.relationships.budgetLines).toMatchObject({ targetEntityId: "BudgetLine", recordField: "budgetId" });
  expect(manifest.entities.BudgetLine!.views.named!.matrix).toEqual({kind: "collection", collectionLayout: "matrix", matrix: { rowField: "ledgerAccountId", columnField: "fiscalPeriodId", valueField: "amount", aggregate: "sum" }});
  expect(manifest.entities.LedgerAccount!.views.record!.preset).toBe("inbox-main-context");
});
test("rejects a matrix with a nonnumeric measure", () => {
  const sources = entries();
  const view = sources[1]!.contract.interfaces!.web!.namedViews!.matrix!;
  if (view.kind !== "collection" || view.collectionLayout !== "matrix") throw new Error("fixture");
  view.matrix.valueField = "description";
  expect(() => buildWebManifest(sources)).toThrow("numeric");
});

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { authoringValidator } from "./schema-validation.js";
test("YAML schema accepts the matrix and main preset, refuses misspelled matrix fields", () => {
  const validator = authoringValidator();
  for (const slug of ["budget", "budget-line"]) {
    const entity = parse(readFileSync(join(dir, `entities/core/${slug}.yaml`), "utf8"));
    expect(() => validator.validate(entity, `${slug}.yaml`)).not.toThrow();
    if (slug === "budget-line") {
      entity.interfaces.web.views.matrix.matrix.unknown = "x";
      expect(() => validator.validate(entity, `${slug}.yaml`)).toThrow();
    }
  }
});
