// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { getGeneratedCrudTables } from "./catalog.js";
import {
  createGeneratedEntity,
  updateGeneratedEntityForTable,
} from "./mutations.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const database = `derived_identifier_${randomUUID().replaceAll("-", "")}`;
const tenantId = randomUUID();
const actor = {
  tenantId,
  userId: randomUUID(),
  roles: ["Organization.All.ReadWrite"],
  groups: [],
  scope: "self" as const,
};
let admin: SQL;
let privileged: DatabaseRuntime;
let runtime: DatabaseRuntime;

describe("database-backed create-time identifiers", () => {
  beforeAll(async () => {
    admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
    await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    url.username = "openshapeforge_app";
    url.password = "openshapeforge_app";
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 6 });
  }, 90_000);

  afterAll(async () => {
    await runtime?.close();
    await privileged?.close();
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.close();
  });

  test("allocates suffixes atomically, keeps keys stable, and scopes uniqueness by tenant", async () => {
    const table = getGeneratedCrudTables().find(
      (candidate) => candidate.source?.authoringEntityName === "Template",
    )!;
    expect(table.columns.find((column) => column.sourceField === "key")?.deriveOnCreate)
      .toMatchObject({ sourceField: "name", conflictColumns: ["tenant_id", "key"] });

    const created = await Promise.all([
      createGeneratedEntity(runtime.db, actor, {
        table: table.name,
        values: { name: "Café Offer" },
      }),
      createGeneratedEntity(runtime.db, actor, {
        table: table.name,
        values: { name: "Café Offer" },
      }),
    ]);
    expect(created.map((row) => row.key).sort()).toEqual(["cafe-offer", "cafe-offer-2"]);

    const renamed = await updateGeneratedEntityForTable(
      runtime.db,
      actor,
      table,
      String(created[0]!.id),
      { name: "Renamed offer" },
    );
    expect(renamed?.key).toBe(created[0]!.key);

    const otherTenant = await createGeneratedEntity(runtime.db, {
      ...actor,
      tenantId: randomUUID(),
    }, {
      table: table.name,
      values: { name: "Café Offer" },
    });
    expect(otherTenant.key).toBe("cafe-offer");

    await expect(createGeneratedEntity(runtime.db, actor, {
      table: table.name,
      values: { name: "Caller choice", key: "caller-choice" },
    })).rejects.toMatchObject({ operationError: { code: "BAD_USER_INPUT" } });
  }, 30_000);
});
