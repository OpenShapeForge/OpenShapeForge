// SPDX-License-Identifier: BUSL-1.1
/**
 * DB-free unit tests for the entity role guard. The e2e authorization suite
 * cannot construct a relationship-traversal DENY case (all shipped entities
 * share the Relaties vocabulary), so the deny branches — including the
 * traversal target-read gate inside listGeneratedEntityRelation — are pinned
 * here: the guard throws before any transaction opens, so no database is
 * needed.
 */
import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import {
  __requireEntityOperationForTests as requireEntityOperation,
  getGeneratedCrudTables,
  listGeneratedEntityRelation,
} from "../generated-crud.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

// Pinned by name: tables[0] is whatever sorts first in the manifest, and the
// assertions below name this entity's Relations.* roles. Since the ERP catalog
// (#403) the first table is a RealEstate entity, so position is not identity.
const table = getGeneratedCrudTables().find((t) => t.name === "erp.relations")!;
const noRoleSession = { tenantId: "tenant", userId: "user", roles: [] as string[] };

function captureThrow(fn: () => unknown): GraphQLError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    return error as GraphQLError;
  }
  throw new Error("expected the guard to throw");
}

describe("requireEntityOperation", () => {
  test("denies every operation for a session without matching roles", () => {
    for (const operation of ["read", "create", "update", "delete"] as const) {
      const error = captureThrow(() =>
        requireEntityOperation(table, operation, noRoleSession),
      );
      expect(error.extensions.code).toBe("FORBIDDEN");
      expect(error.extensions.status).toBe(403);
      expect(error.message).toContain(operation);
      // No role enumeration: the allowed role list must never leak.
      expect(error.message).not.toContain("Relations.All");
      expect(error.message).not.toContain("Relaties.All");
    }
  });

  test("allows an operation when a session role intersects the allow-list", () => {
    expect(() =>
      requireEntityOperation(table, "read", {
        ...noRoleSession,
        roles: ["Relations.All.Read"],
      }),
    ).not.toThrow();
    // The write role also satisfies delete. (The authored-vs-normalized
    // vocabulary union is covered by the compiler's backend-manifest tests;
    // since #403 the shipped catalog is authored in English, so the manifest
    // carries a single spelling per role.)
    expect(() =>
      requireEntityOperation(table, "delete", {
        ...noRoleSession,
        roles: ["Relations.All.ReadWrite"],
      }),
    ).not.toThrow();
  });

  test("read roles do not grant mutations", () => {
    const error = captureThrow(() =>
      requireEntityOperation(table, "create", {
        ...noRoleSession,
        roles: ["Relations.All.Read"],
      }),
    );
    expect(error.extensions.code).toBe("FORBIDDEN");
  });

  test("fails closed on a table without role metadata (stale manifest)", () => {
    const stale = { ...table, name: "erp.stale_table", source: {} } as GeneratedTable;
    const error = captureThrow(() =>
      requireEntityOperation(stale, "read", {
        ...noRoleSession,
        roles: ["Relations.All.ReadWrite"],
      }),
    );
    expect(error.extensions.code).toBe("FORBIDDEN");
    expect(error.message).toContain("no role metadata");
  });

  test("relationship traversal gates the TARGET entity's read roles before any DB use", async () => {
    // The guard is the first statement of listGeneratedEntityRelation, so a
    // null db proves the deny path rejects before any transaction could open.
    const attempt = listGeneratedEntityRelation(
      null as unknown as OpenShapeForgeDatabase,
      noRoleSession,
      {
        parent: {},
        parentTable: table,
        relationship: {
          name: "anything",
          target: "Anything",
          type: "T",
          resolve: "hasMany",
          foreignKey: "relation_id",
        },
        targetTable: table,
      },
    );
    await expect(attempt).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN", status: 403 },
    });
  });
});
