// SPDX-License-Identifier: BUSL-1.1
/**
 * A single-row lookup by primary key compares the uncast key column with a
 * typed parameter, so the primary-key index applies. `<pk>::text = $1` hid
 * the column behind a cast. Runs against a driver that records statements and
 * answers from a script, so no database is involved.
 */
import { describe, expect, test } from "bun:test";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Transaction,
} from "kysely";
import type { DB } from "../../generated/db/types.js";
import { readChangeBatch } from "../../platform/entity-change-stream.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { primaryKeyEquals } from "./columns.js";
import { assertRecordPermissionInTransaction } from "./record-permissions.js";
import { listGeneratedEntityRelation } from "./relations.js";
import type { GeneratedCrudTable } from "./types.js";

const id = "44444444-4444-4444-8444-444444444444";
const tenantId = "11111111-1111-4111-8111-111111111111";

function session(roles: string[]) {
  return { tenantId, userId: "22222222-2222-4222-8222-222222222222", roles, groups: [], scope: "self" as const };
}

function scriptedDatabase(statements: string[], rowsFor: (sql: string) => unknown[] = () => []) {
  const connection: DatabaseConnection = {
    executeQuery: async (query) => {
      statements.push(query.sql);
      return { rows: rowsFor(query.sql) as never[] };
    },
    streamQuery: async function* () {},
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => Object.assign(new DummyDriver(), { acquireConnection: async () => connection }),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function primaryKeyLookups(statements: string[], column: string): string[] {
  return statements.filter((statement) => statement.includes(`${column} = $`) || statement.includes(`${column}::text`));
}

describe("primary-key equality", () => {
  const table = { primaryKey: "id", columns: [{ name: "id", type: "uuid", primaryKey: true }] } as unknown as GeneratedCrudTable;
  const db = scriptedDatabase([]);

  test("binds a canonical uuid as a uuid parameter against the uncast column", () => {
    const compiled = primaryKeyEquals(table, id, "row_source").compile(db);
    expect(compiled.sql).toBe('"row_source"."id" = $1::uuid');
    expect(compiled.parameters).toEqual([id]);
  });

  test("matches nothing for an id the text comparison could never match", () => {
    for (const other of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "not-a-uuid", "", 42, null]) {
      const compiled = primaryKeyEquals(table, other).compile(db);
      expect(compiled.sql).toBe("false");
      expect(compiled.parameters).toEqual([]);
    }
  });

  test("keeps the text comparison for a key that is not a uuid", () => {
    const text = { primaryKey: "code", columns: [{ name: "code", type: "text", primaryKey: true }] } as unknown as GeneratedCrudTable;
    expect(primaryKeyEquals(text, "A-1").compile(db).sql).toBe('"code"::text = $1');
  });
});

describe("primary-key lookups use the uncast key", () => {
  test("record permission check", async () => {
    const statements: string[] = [];
    const table = {
      schema: "example",
      table: "records",
      name: "records",
      tenantScoped: true,
      primaryKey: "id",
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "authorization", type: "jsonb", sourceField: "authorization" },
      ],
      source: { authorization: { recordPermissions: { field: "authorization", column: "authorization", empty: "public" } } },
    } as unknown as GeneratedCrudTable;
    const db = scriptedDatabase(statements);
    await expect(assertRecordPermissionInTransaction(db as unknown as Transaction<DB>, session([]), table, id, "edit"))
      .rejects.toThrow();
    expect(primaryKeyLookups(statements, '"row_source"."id"')).toEqual([
      expect.stringMatching(/"row_source"\."id" = \$\d+::uuid/),
    ]);
  });

  test("relationship traversal parent predicate", async () => {
    const statements: string[] = [];
    const tables = getGeneratedCrudTables();
    const parent = tables.find((candidate) => candidate.name === "erp.asset_groups")!;
    const target = tables.find((candidate) => candidate.name === "erp.assets")!;
    const relationship = parent.source!.graphql!.relationships!.find((entry) => entry.name === "assets")!;
    const role = parent.source!.authorization!.roles.read[0]!;
    await listGeneratedEntityRelation(scriptedDatabase(statements), session([role]), {
      parent: { [parent.primaryKey!]: id },
      parentTable: parent,
      relationship,
      targetTable: target,
    });
    const lookups = primaryKeyLookups(statements, `"relation_parent"."${parent.primaryKey}"`);
    expect(lookups.length).toBeGreaterThan(0);
    for (const statement of lookups) {
      expect(statement).toMatch(new RegExp(`"relation_parent"\\."${parent.primaryKey}" = \\$\\d+::uuid`));
      expect(statement).not.toContain(`"relation_parent"."${parent.primaryKey}"::text`);
    }
  });

  test("change stream visibility check", async () => {
    const statements: string[] = [];
    const table = getGeneratedCrudTables().find((candidate) =>
      candidate.realtime && candidate.primaryKey && candidate.source?.authoringEntityName)!;
    const role = table.source!.authorization!.roles.read[0]!;
    const event = {
      id: "55555555-5555-4555-8555-555555555555",
      tenant_id: tenantId,
      aggregate_type: table.source!.authoringEntityName,
      aggregate_id: id,
      event_type: "updated",
      payload: {},
      sequence: "1",
      occurred_at: new Date(0),
      delivery_sequence: "6",
    };
    const db = scriptedDatabase(statements, (statement) =>
      /select \* from "platform"\."entity_events"/.test(statement) ? [event] : []);
    await readChangeBatch(db, session([role]), "5", false);
    const lookups = primaryKeyLookups(statements, `"${table.primaryKey}"`)
      .filter((statement) => statement.includes(`from "${table.schema}"."${table.table}"`));
    expect(lookups).toEqual([expect.stringContaining(`where "${table.primaryKey}" = $1::uuid`)]);
  });
});
