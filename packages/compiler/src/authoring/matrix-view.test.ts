// SPDX-License-Identifier: BUSL-1.1
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
  if (view.kind !== "collection" || view.collectionLayout !== "matrix" || "source" in view.matrix) throw new Error("fixture");
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

// An operation matrix: the server computes the cells, the view declares what the browser shows and calls.
import { assertEntityAuthoring } from "./entity-authoring.js";
type OperationMatrix = import("./types.js").OperationMatrixDefinition;
const planning = (): { kind: "collection"; collectionLayout: "matrix"; matrix: OperationMatrix } => ({ kind: "collection", collectionLayout: "matrix", matrix: {
  source: "operation", read: "Budget.table", apply: "Budget.applyMatrix", rows: { parentField: "budgetId" }, total: "FY", refresh: ["FiscalPeriod"],
  measures: [
    { key: "budget", label: { en: "Budget", nl: "Begroting" }, heading: "B", format: "amount", editable: true },
    { key: "delta", label: "Δ%", format: "percentage", align: "center" },
  ],
} });
/** A plugin-backed Operation as an owning plugin authors it on Budget. */
const operation = (handler: string, data: "read" | "write") => ({
  name: handler, description: `${handler} of a budget.`, implementation: { type: "plugin", plugin: "planning", handler },
  target: { scope: "record", inputField: "budgetId" },
  input: { schema: { type: "object", required: ["budgetId"], additionalProperties: false, properties: { budgetId: { type: "string", format: "uuid" } } } },
  output: { schema: { type: "object" } }, auth: { mode: "session", roles: ["Finance.All.ReadWrite"] }, tenancy: { mode: "required" },
  effects: { data, external: "none" }, reliability: { idempotency: { mode: "natural" } }, confirmation: { mode: "none" }, errors: [],
});
function withPlanning(change: (matrix: OperationMatrix) => void = () => {}, operations: Record<string, ReturnType<typeof operation>> = { table: operation("table", "read"), applyMatrix: operation("applyMatrix", "write") }) {
  const view = planning();
  change(view.matrix);
  return ["budget", "budget-line", "ledger-account", "fiscal-period", "fiscal-year", "cost-dimension"].map(slug => {
    const artifacts = loadEntity(dir, slug);
    if (slug === "budget") artifacts.coreEntity.operations = { ...artifacts.coreEntity.operations, ...operations } as never;
    if (slug === "budget-line") (artifacts.coreEntity.interfaces!.web!.views as Record<string, unknown>).planning = view;
    return { slug, path: `entities/core/${slug}.yaml`, origin: "core" as const, contract: compile(artifacts) };
  });
}
test("projects an operation matrix with localized measures and its refresh entities", () => {
  expect(buildWebManifest(withPlanning()).entities.BudgetLine!.views.named!.planning).toEqual({ kind: "collection", collectionLayout: "matrix", matrix: {
    source: "operation", read: "Budget.table", apply: "Budget.applyMatrix", rows: { parentField: "budgetId" },
    measures: [
      { key: "budget", label: { en: "Budget", nl: "Begroting" }, heading: { en: "B", nl: "B" }, format: "amount", align: "end", editable: true },
      { key: "delta", label: { en: "Δ%", nl: "Δ%" }, heading: { en: "Δ%", nl: "Δ%" }, format: "percentage", align: "center", editable: false },
    ],
    total: { en: "FY", nl: "FY" }, refresh: ["BudgetLine", "FiscalPeriod"],
  } });
});
test("an operation matrix without measures shows row names only and needs no apply", () => {
  const view = buildWebManifest(withPlanning(matrix => { matrix.measures = []; delete matrix.apply; })).entities.BudgetLine!.views.named!.planning;
  expect(view).toMatchObject({ matrix: { source: "operation", read: "Budget.table", measures: [] } });
  expect(view).not.toHaveProperty("matrix.apply");
});
test("refuses Operations, fields and entities the compiled application does not have", () => {
  expect(() => buildWebManifest(withPlanning(matrix => { matrix.read = "Budget.missing"; }))).toThrow("BudgetLine.planning: matrix read names unknown Operation Budget.missing");
  expect(() => buildWebManifest(withPlanning(matrix => { matrix.apply = "Ledger.applyMatrix"; }))).toThrow("unknown Operation Ledger.applyMatrix");
  // A host may build the manifest from its Web entities only: an entity the matrix refreshes on
  // need not be among them, so a stored-value entity without any Web view is accepted.
  const webOnly = withPlanning(matrix => { matrix.refresh = ["CostDimension"]; }).filter(source => source.slug !== "cost-dimension");
  expect(buildWebManifest(webOnly).entities.BudgetLine!.views.named!.planning).toMatchObject({ matrix: { refresh: ["BudgetLine", "CostDimension"] } });
  expect(() => buildWebManifest(withPlanning(matrix => { matrix.rows = { parentField: "nowhere" }; }))).toThrow("readable and single");
});
test("refuses a read that writes and an apply that only reads", () => {
  expect(() => buildWebManifest(withPlanning(undefined, { table: operation("table", "write"), applyMatrix: operation("applyMatrix", "write") }))).toThrow("must only read");
  expect(() => buildWebManifest(withPlanning(undefined, { table: operation("table", "read"), applyMatrix: operation("applyMatrix", "read") }))).toThrow("must write");
});
test("authoring refuses repeated measures, an editable measure without apply and an unqualified Operation", () => {
  const check = (change: (matrix: OperationMatrix) => void) => {
    const { coreEntity: entity } = loadEntity(dir, "budget-line"), view = planning();
    change(view.matrix);
    (entity.interfaces!.web!.views as Record<string, unknown>).planning = view;
    return () => assertEntityAuthoring(entity, "budget-line.yaml");
  };
  expect(check(() => {})).not.toThrow();
  expect(check(matrix => { matrix.measures.push({ ...matrix.measures[0]! }); })).toThrow("repeats a measure key");
  expect(check(matrix => { delete matrix.apply; })).toThrow("no apply Operation");
  expect(check(matrix => { matrix.read = "table"; })).toThrow("qualified Operation id");
  expect(check(matrix => { matrix.apply = matrix.read; })).toThrow("distinct read and apply");
  expect(check(matrix => { matrix.rows = { parentField: "nowhere" }; })).toThrow("single field");
});
test("YAML schema accepts an operation matrix and refuses mixing it with a record pivot", () => {
  const validator = authoringValidator();
  const entity = parse(readFileSync(join(dir, "entities/core/budget-line.yaml"), "utf8"));
  const set = (matrix: Record<string, unknown>) => { entity.interfaces.web.views.planning = { kind: "collection", collectionLayout: "matrix", matrix }; };
  set(planning().matrix);
  expect(() => validator.validate(entity, "budget-line.yaml")).not.toThrow();
  set({ ...planning().matrix, rowField: "ledgerAccountId" });
  expect(() => validator.validate(entity, "budget-line.yaml")).toThrow();
  set({ source: "operation", measures: [] });
  expect(() => validator.validate(entity, "budget-line.yaml")).toThrow();
  set({ ...planning().matrix, read: "table" });
  expect(() => validator.validate(entity, "budget-line.yaml")).toThrow();
  set({ ...planning().matrix, measures: [{ key: "budget", label: "Budget", format: "money" }] });
  expect(() => validator.validate(entity, "budget-line.yaml")).toThrow();
});
