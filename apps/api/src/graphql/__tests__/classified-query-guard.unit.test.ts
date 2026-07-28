// SPDX-License-Identifier: BUSL-1.1
/**
 * DB-free unit tests for the classified filter/sort guard as wired into the
 * generated CRUD core (#164).
 *
 * generated-authz.test.ts pins the guard's own semantics; what matters here is
 * that listGeneratedEntities applies it, and applies it BEFORE any statement
 * runs — a guard that fired after the query would already have leaked the
 * answer through timing and totalCount. Passing a null database proves the
 * ordering: nothing may touch it.
 *
 * No shipped entity declares a classification, so a column is tagged for the
 * duration of a test and restored afterwards (the same arming the e2e suites
 * use, inlined here to keep this file free of the e2e harness).
 */
import { describe, expect, test } from "bun:test";
import {
  getGeneratedCrudTables,
  listGeneratedEntities,
} from "../generated-crud.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";

type GeneratedColumn = ReturnType<typeof getGeneratedCrudTables>[number]["columns"][number];

const table = getGeneratedCrudTables()[0]!;
const readRole = table.source!.authorization!.roles.read[0]!;
const writeRole = table.source!.authorization!.roles.update[0]!;
const classified = table.columns.find(
  (column) => column.type === "text" && !column.required && !column.primaryKey,
)!;
const field =
  classified.sourceField ??
  classified.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

const readOnlySession = { tenantId: "tenant", userId: "user", roles: [readRole] };
const writeSession = { tenantId: "tenant", userId: "user", roles: [writeRole] };

/** The database that must never be reached. */
const noDb = null as unknown as OpenShapeForgeDatabase;

async function withClassifiedColumn(
  column: GeneratedColumn,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = column.classification;
  column.classification = "pii";
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete column.classification;
    } else {
      column.classification = previous;
    }
  }
}

describe("classified filter/sort guard in listGeneratedEntities", () => {
  test("refuses a classified filter for a read-only session before any SQL", async () => {
    await withClassifiedColumn(classified, async () => {
      for (const filter of [{ [field]: "probe" }, { [`${field}In`]: ["probe"] }]) {
        await expect(
          listGeneratedEntities(noDb, readOnlySession, { table: table.name, filter }),
        ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN", status: 403 } });
      }
    });
  });

  test("refuses a classified sort for a read-only session before any SQL", async () => {
    await withClassifiedColumn(classified, async () => {
      await expect(
        listGeneratedEntities(noDb, readOnlySession, {
          table: table.name,
          sort: { field, direction: "desc" },
        }),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN", status: 403 } });
    });
  });

  test("names the field but never the roles that would have allowed it", async () => {
    await withClassifiedColumn(classified, async () => {
      const error = await listGeneratedEntities(noDb, readOnlySession, {
        table: table.name,
        filter: { [field]: "probe" },
      }).catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(field);
      expect((error as Error).message).not.toContain(writeRole);
    });
  });

  test("a write grant passes the guard and proceeds to the database", async () => {
    await withClassifiedColumn(classified, async () => {
      // Reaching the null database is the assertion: the guard let it through,
      // so the failure is a TypeError from the DB layer, not a FORBIDDEN.
      const error = await listGeneratedEntities(noDb, writeSession, {
        table: table.name,
        filter: { [field]: "probe" },
        sort: { field, direction: "asc" },
      }).catch((caught: unknown) => caught);
      expect((error as { extensions?: { code?: string } })?.extensions?.code).toBeUndefined();
    });
  });

  test("an unclassified column is filterable and sortable by a read-only session", async () => {
    const error = await listGeneratedEntities(noDb, readOnlySession, {
      table: table.name,
      filter: { [field]: "probe" },
      sort: { field, direction: "asc" },
    }).catch((caught: unknown) => caught);
    expect((error as { extensions?: { code?: string } })?.extensions?.code).toBeUndefined();
  });
});
