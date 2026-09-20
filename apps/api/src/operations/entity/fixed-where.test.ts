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
});
