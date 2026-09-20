// SPDX-License-Identifier: BUSL-1.1
/**
 * A runtime-owned fixed condition renders `null` as SQL absence. A caller
 * filter drops a null value ("no filter"); a runtime predicate that says
 * "the row nobody owns" must become `is null`, not `= null`, which matches
 * nothing and made the OAuth callback create a second organization
 * connection. Compiles the SQL without connecting.
 */
import { describe, expect, test } from "bun:test";
import { createDatabaseRuntime } from "../../db/connection.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { __buildFilterConditionsForTests as buildFilterConditions } from "./queries.js";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  roles: [],
  groups: [],
  scope: "self" as const,
};

describe("fixed where conditions", () => {
  const table = getGeneratedCrudTables().find((candidate) => candidate.name === "erp.documents")!;
  const runtime = createDatabaseRuntime({
    databaseUrl: "postgres://nobody:nobody@127.0.0.1:1/never",
    maxConnections: 1,
  });

  test("renders a null fixed value as `is null` and a caller null as no filter", () => {
    const compiled = buildFilterConditions(table, session, { title: null }, [
      { column: "relation_id", value: null },
      { column: "title", value: "x" },
    ]).compile(runtime.db);
    expect(compiled.sql).toContain('"row_source"."relation_id" is null');
    expect(compiled.sql).toContain('"row_source"."title" = $');
    expect(compiled.parameters).toEqual(["x"]);
  });

  test("renders uuid and text membership as ANY($1::type[]) for FieldIn, {in}, and fixed arrays", () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    ];
    const titles = ["Alpha", "Beta"];

    const fixed = buildFilterConditions(table, session, undefined, [
      { column: "id", value: ids },
    ]).compile(runtime.db);
    expect(fixed.sql).toContain('"row_source"."id" = ANY($1::uuid[])');
    expect(fixed.parameters).toEqual([`{"${ids[0]}","${ids[1]}"}`]);

    const filtered = buildFilterConditions(table, session, { id: { in: ids } }).compile(
      runtime.db,
    );
    expect(filtered.sql).toContain('"row_source"."id" = ANY($1::uuid[])');
    expect(filtered.parameters).toEqual([`{"${ids[0]}","${ids[1]}"}`]);

    const fieldIn = buildFilterConditions(table, session, { idIn: ids }).compile(runtime.db);
    expect(fieldIn.sql).toContain('"row_source"."id" = ANY($1::uuid[])');
    expect(fieldIn.parameters).toEqual([`{"${ids[0]}","${ids[1]}"}`]);

    const textIn = buildFilterConditions(table, session, { title: { in: titles } }).compile(
      runtime.db,
    );
    expect(textIn.sql).toContain('"row_source"."title" = ANY($1::text[])');
    expect(textIn.parameters).toEqual(['{"Alpha","Beta"}']);

    const textFieldIn = buildFilterConditions(table, session, { titleIn: titles }).compile(
      runtime.db,
    );
    expect(textFieldIn.sql).toContain('"row_source"."title" = ANY($1::text[])');
    expect(textFieldIn.parameters).toEqual(['{"Alpha","Beta"}']);
  });

  test("keeps a large membership set as one array parameter", () => {
    const ids = Array.from(
      { length: 1_000 },
      (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    );
    const compiled = buildFilterConditions(table, session, { idIn: ids }).compile(runtime.db);
    expect(compiled.sql).toContain('"row_source"."id" = ANY($1::uuid[])');
    expect(compiled.sql).not.toContain(" in (");
    expect(compiled.parameters).toHaveLength(1);
    expect(String(compiled.parameters[0]).startsWith("{")).toBe(true);
    expect(String(compiled.parameters[0]).split(",")).toHaveLength(1_000);
  });
});
