// SPDX-License-Identifier: BUSL-1.1
/**
 * DB-free unit tests for the page fields an entity list Operation accepts.
 *
 * The execute transports (`POST /api/operations/:id/execute`, GraphQL
 * `executeOperation`) hand the caller's body to the entity dispatcher without
 * a list schema. Only limit, cursor, filter, sort and includeTotalCount may
 * reach the list query: `fixedWhere` is a runtime-owned predicate that skips
 * the classified filter guard, and `table` would re-target the Operation.
 *
 * The database is a tripwire, so reaching it proves the caller's extra keys
 * were dropped before any of them could act.
 */
import { describe, expect, test } from "bun:test";
import { entityOperationRef, executeEntityOperation, getGeneratedCrudTables } from "../../operations/entity/index.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";

const tables = getGeneratedCrudTables();
const table = tables.find((candidate) => candidate.name === "erp.relations")!;
const readRole = table.source!.authorization!.roles.read[0]!;
const session = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  roles: [readRole],
};
const unreadable = tables.find(
  (candidate) => candidate.name !== table.name &&
    !candidate.source?.authorization?.roles.read.includes(readRole),
)!;

let reached = false;
const tripwire = new Proxy({}, {
  get() {
    reached = true;
    throw new Error("reached the database");
  },
}) as OpenShapeForgeDatabase;

/** The error code the dispatcher answered, and whether it got as far as SQL. */
async function listWith(input: Record<string, unknown>) {
  reached = false;
  const result = await executeEntityOperation(tripwire, session, {
    operation: entityOperationRef(table, "list"),
    input,
  });
  return { code: "error" in result ? result.error.code : undefined, reached };
}

describe("entity list input", () => {
  test("ignores a caller-supplied fixedWhere", async () => {
    expect(await listWith({ fixedWhere: [{ column: "not_a_column", value: "probe" }] }))
      .toEqual({ code: "INTERNAL_SERVER_ERROR", reached: true });
  });

  test("keeps the Operation's own table when the body names another", async () => {
    expect(await listWith({ table: unreadable.name }))
      .toEqual({ code: "INTERNAL_SERVER_ERROR", reached: true });
  });
});
