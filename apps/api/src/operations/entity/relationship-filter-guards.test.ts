// SPDX-License-Identifier: BUSL-1.1
/**
 * A relationship `any` sub-filter and a relationship traversal match related
 * rows by exact field name, so the oracle guards must resolve those names the
 * same way: a field whose own name ends in `In` is that field, not the `In`
 * membership alias of a shorter one. The `any` sub-filter must also refuse the
 * related entity's elicited-output field, as a top-level filter does.
 *
 * No shipped entity has such a field, so a related column is renamed,
 * classified or made the elicited target for the duration of a test and
 * restored afterwards. Everything is decided before SQL: the filter is only
 * compiled, and the traversal is handed a database that must never be reached.
 */
import { describe, expect, test } from "bun:test";
import { createDatabaseRuntime, type OpenShapeForgeDatabase } from "../../db/connection.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { __buildFilterConditionsForTests as buildFilterConditions } from "./queries.js";
import { listGeneratedEntityRelation } from "./relations.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const tables = getGeneratedCrudTables();
const parent = tables.find((candidate) => candidate.name === "erp.asset_groups")!;
const related = tables.find((candidate) => candidate.name === "erp.assets")!;
const relationship = parent.source!.graphql!.relationships!.find((entry) => entry.name === "assets")!;
const readRole = related.source!.authorization!.roles.read.find((role) => role.endsWith(".Read"))!;
const writeRole = related.source!.authorization!.roles.update[0]!;
const probe = related.columns.find(
  (column) => column.type === "text" && !column.required && !column.primaryKey,
)!;
const foreignKey = related.columns.find((column) => column.name === relationship.foreignKey)!;

function session(role: string) {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles: [role],
    groups: [],
    scope: "self" as const,
  };
}

const noDb = null as unknown as OpenShapeForgeDatabase;
const runtime = createDatabaseRuntime({
  databaseUrl: "postgres://nobody:nobody@127.0.0.1:1/never",
  maxConnections: 1,
});

function withColumn<T>(column: GeneratedCrudColumn, patch: Partial<GeneratedCrudColumn>, fn: () => T): T {
  const previous = { sourceField: column.sourceField, classification: column.classification };
  Object.assign(column, patch);
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete (column as Record<string, unknown>)[key];
      else (column as Record<string, unknown>)[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function withElicitedTarget<T>(table: GeneratedCrudTable, into: string, fn: () => T): T {
  const source = table.source as { secureInputOnCreate?: unknown };
  const previous = source.secureInputOnCreate;
  source.secureInputOnCreate = { into };
  try {
    return fn();
  } finally {
    if (previous === undefined) delete source.secureInputOnCreate;
    else source.secureInputOnCreate = previous;
  }
}

function anyFilter(field: string) {
  return { [relationship.name]: { any: { [field]: { eq: "probe" } } } };
}

describe("relationship any filter guards", () => {
  test("refuses a classified related field whose name ends in In", () => {
    withColumn(probe, { sourceField: "probeIn", classification: "pii" }, () => {
      expect(() => buildFilterConditions(parent, session(readRole), anyFilter("probeIn")))
        .toThrow(expect.objectContaining({ operationError: expect.objectContaining({ code: "FORBIDDEN" }) }));
    });
  });

  test("refuses the related entity's elicited-output field", () => {
    const field = fieldNameForColumn(probe);
    withElicitedTarget(related, field, () => {
      expect(() => buildFilterConditions(parent, session(writeRole), anyFilter(field)))
        .toThrow(expect.objectContaining({ operationError: expect.objectContaining({ code: "FORBIDDEN" }) }));
    });
  });

  test("still compiles an exact match on a readable related field", () => {
    withColumn(probe, { sourceField: "probeIn" }, () => {
      const compiled = buildFilterConditions(parent, session(readRole), anyFilter("probeIn")).compile(runtime.db);
      expect(compiled.sql).toContain(`"related"."${probe.name}" = $`);
    });
  });
});

describe("relationship traversal guard", () => {
  test("refuses a classified foreign key whose field name ends in In before any SQL", async () => {
    await withColumn(foreignKey, { sourceField: "assetGroupIn", classification: "pii" }, () =>
      expect(listGeneratedEntityRelation(noDb, session(readRole), {
        parent: { [parent.primaryKey!]: "33333333-3333-4333-8333-333333333333" },
        parentTable: parent,
        relationship,
        targetTable: related,
      })).rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } }));
  });
});
