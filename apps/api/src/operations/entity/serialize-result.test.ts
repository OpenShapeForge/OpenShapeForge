// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { serializeEntityResult, serializeEntityRow } from "./serialize-result.js";
import { serializeGeneratedRestRow } from "../../rest/serialize-generated-row.js";
import type { EntityOperationOffer, GeneratedCrudTable } from "./types.js";

const table = { name: "Example", schema: "example", table: "examples", tenantScoped: true,
  generatedCrud: true, domainInternal: false, primaryKey: "id", columns: [
    { name: "id", type: "uuid", required: true, primaryKey: true, generated: null },
    { name: "created_by", sourceField: "createdBy", type: "uuid", required: false, primaryKey: false, generated: null },
  ], source: { computedFields: [{ field: "labels", resolver: "labelRules" }] },
} satisfies GeneratedCrudTable;
const row = { id: "example-id", created_by: "verified-actor", labels: ["New"], internalSecret: "never exposed" };
const offers: EntityOperationOffer[] = [{ operation: { id: "Example.get", intent: "get" }, available: true }];

test("runtime and REST share one authored field projection", () => {
  expect(serializeGeneratedRestRow).toBe(serializeEntityRow);
  for (const intent of ["get", "create", "update"] as const) {
    expect(serializeEntityResult(table, { intent, data: row, operations: offers })).toEqual({
      intent, data: { id: "example-id", createdBy: "verified-actor", labels: ["New"] }, operations: offers,
    });
  }
});
test("list preserves cursor, counts and per-record offers without raw columns", () => {
  expect(serializeEntityResult(table, { intent: "list", data: { items: [{ data: row, operations: offers }], nextCursor: "cursor", totalCount: 1 }, operations: [] })).toEqual({
    intent: "list", data: { items: [{ data: serializeEntityRow(table, row), operations: offers }], nextCursor: "cursor", totalCount: 1 }, operations: [],
  });
});
test("null records, delete results and canonical failures are preserved", () => {
  const missing = { intent: "get" as const, data: null, operations: [] };
  expect(serializeEntityResult(table, missing)).toEqual(missing);
  const deleted = { intent: "delete" as const, data: { deleted: true }, operations: [] };
  expect(serializeEntityResult(table, deleted)).toBe(deleted);
  const failure = { intent: "create" as const, error: { code: "FORBIDDEN", message: "Niet toegestaan.", retryable: false } };
  expect(serializeEntityResult(table, failure)).toBe(failure);
});
