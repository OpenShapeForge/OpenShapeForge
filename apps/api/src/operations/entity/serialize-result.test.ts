// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { serializeGeneratedRestRow } from "../../rest/serialize-generated-row.js";
import { projectRows } from "./catalog.js";
import {
  normalizeEntityStorageRow,
  serializeEntityResult,
  serializeEntityRow,
} from "./serialize-result.js";
import type { EntityOperationOffer, GeneratedCrudTable } from "./types.js";

const table = {
  name: "Example",
  schema: "example",
  table: "examples",
  tenantScoped: true,
  generatedCrudEligible: true,
  domainInternal: false,
  primaryKey: "id",
  columns: [
    { name: "id", type: "uuid", required: true, primaryKey: true, generated: null },
    {
      name: "created_by",
      sourceField: "createdBy",
      type: "uuid",
      required: false,
      primaryKey: false,
      generated: null,
    },
  ],
  source: { computedFields: [{ field: "labels", resolver: "labelRules" }] },
} satisfies GeneratedCrudTable;
const row = {
  id: "example-id",
  created_by: "verified-actor",
  labels: ["New"],
  internalSecret: "never exposed",
};
const offers: EntityOperationOffer[] = [
  { operation: { id: "Example.get", intent: "get" }, available: true },
];

test("runtime and REST share one authored field projection", () => {
  expect(serializeGeneratedRestRow).toBe(serializeEntityRow);
  for (const intent of ["get", "create", "update"] as const) {
    expect(serializeEntityResult(table, { intent, data: row, operations: offers })).toEqual({
      intent,
      data: { id: "example-id", createdBy: "verified-actor", labels: ["New"] },
      operations: offers,
    });
  }
});
test("list preserves cursor, counts and per-record offers without raw columns", () => {
  expect(
    serializeEntityResult(table, {
      intent: "list",
      data: { items: [{ data: row, operations: offers }], nextCursor: "cursor", totalCount: 1 },
      operations: [],
    }),
  ).toEqual({
    intent: "list",
    data: {
      items: [{ data: serializeEntityRow(table, row), operations: offers }],
      nextCursor: "cursor",
      totalCount: 1,
    },
    operations: [],
  });
});
test("null records, delete results and canonical failures are preserved", () => {
  const missing = { intent: "get" as const, data: null, operations: [] };
  expect(serializeEntityResult(table, missing)).toEqual(missing);
  const deleted = { intent: "delete" as const, data: { deleted: true }, operations: [] };
  expect(serializeEntityResult(table, deleted)).toBe(deleted);
  const failure = {
    intent: "create" as const,
    error: { code: "FORBIDDEN", message: "Niet toegestaan.", retryable: false },
  };
  expect(serializeEntityResult(table, failure)).toBe(failure);
});

const bigintTable = {
  ...table,
  columns: [
    ...table.columns,
    {
      name: "artifact_version",
      sourceField: "artifactVersion",
      type: "bigint",
      required: false,
      primaryKey: false,
      generated: null,
    },
    {
      name: "byte_size",
      sourceField: "byteSize",
      type: "bigint",
      required: false,
      primaryKey: false,
      generated: null,
    },
  ],
} satisfies GeneratedCrudTable;

test("keeps bigint text exact on every public entity result boundary", () => {
  const stored = {
    ...row,
    artifact_version: "2147483648",
    byte_size: "9007199254740993",
  };
  const projected = projectRows(
    bigintTable,
    {
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      roles: [],
    },
    [stored],
  );
  expect(projected[0]).toMatchObject({
    artifact_version: "2147483648",
    byte_size: "9007199254740993",
  });
  const [firstProjected] = projected;
  if (!firstProjected) throw new Error("Expected one projected row.");
  expect(serializeEntityRow(bigintTable, firstProjected)).toMatchObject({
    artifactVersion: "2147483648",
    byteSize: "9007199254740993",
  });
  expect(
    serializeEntityResult(bigintTable, {
      intent: "list",
      data: { items: [{ data: stored, operations: [] }], nextCursor: null, totalCount: 1 },
      operations: [],
    }),
  ).toMatchObject({
    data: { items: [{ data: { artifactVersion: "2147483648", byteSize: "9007199254740993" } }] },
  });
  expect(stored).toMatchObject({ artifact_version: "2147483648", byte_size: "9007199254740993" });
});

test("prints a bigint or a number a handler produced as the same decimal text", () => {
  expect(
    normalizeEntityStorageRow(bigintTable, {
      ...row,
      artifact_version: 2_147_483_648,
      byte_size: 9_007_199_254_740_993n,
    }),
  ).toMatchObject({
    artifact_version: "2147483648",
    byte_size: "9007199254740993",
  });
  expect(normalizeEntityStorageRow(bigintTable, { ...row, artifact_version: null })).toMatchObject({
    artifact_version: null,
  });
});
