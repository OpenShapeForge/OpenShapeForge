// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import { getGeneratedCrudTables } from "./catalog.js";
import {
  createGeneratedEntity,
  createGeneratedEntityInTransaction,
  updateGeneratedEntityForTable,
} from "./mutations.js";
import type { GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const database = `derived_identifier_${randomUUID().replaceAll("-", "")}`;
const tenantId = randomUUID();
const actor = {
  tenantId,
  userId: randomUUID(),
  roles: ["Templates.Manage"],
  groups: [],
  scope: "self" as const,
};
let admin: SQL;
let privileged: DatabaseRuntime;
let runtime: DatabaseRuntime;

describe("database-backed create-time identifiers", () => {
  beforeAll(async () => {
    const adminLocation = new URL(adminUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(adminLocation.hostname) || adminLocation.pathname !== "/postgres") {
      throw new Error("Derived identifier tests require a local scratch admin database, never an application database.");
    }
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
    expect(created.map((row) => row.name)).toEqual(["Café Offer", "Café Offer"]);

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

  test("partial-index authoring saves concurrent active and inactive records with unique keys and unchanged names", async () => {
    const fixturePath = new URL("../../../../../packages/compiler/src/authoring/compiler/derive-on-create.fixtures.ts", import.meta.url).pathname;
    const generatorPath = new URL("../../../../../packages/compiler/src/generate.ts", import.meta.url).pathname;
    const { compilePartialDerivedIdentifierFixture } = await import(fixturePath);
    const { generateArtifacts } = await import(generatorPath);
    const artifacts = generateArtifacts(compilePartialDerivedIdentifierFixture());
    const schema = artifacts.find((artifact: { path: string }) => artifact.path.endsWith("schema.sql"))!.contents;
    const fixtureManifest = JSON.parse(artifacts.find((artifact: { path: string }) => artifact.path.endsWith("manifest.json"))!.contents);
    const table = fixtureManifest.tables.find((table: GeneratedCrudTable) => table.table === "derived_identifier_fixtures") as GeneratedCrudTable;
    await sql.raw(schema).execute(privileged.db);
    await sql`grant select, insert, update, delete on erp.derived_identifier_fixtures to openshapeforge_app`.execute(privileged.db);
    const session = { ...actor, roles: ["Relaties.All.ReadWrite"] };
    const create = (active: boolean, inputSession = session) => withDbSession(runtime.db, inputSession, (trx, dbSession) =>
      createGeneratedEntityInTransaction(trx, dbSession, table, { name: "Café Offer", active }),
    );
    const created = await Promise.all([create(true), create(false), create(true), create(false)]);
    expect(created.map((row) => row.key).sort())
      .toEqual(["cafe-offer", "cafe-offer-2", "cafe-offer-3", "cafe-offer-4"]);
    expect(created.every((row) => row.name === "Café Offer")).toBe(true);
    expect(created.filter((row) => row.active === false)).toHaveLength(2);

    const otherTenant = await create(false, { ...session, tenantId: randomUUID() });
    expect(otherTenant.key).toBe("cafe-offer");
    expect(otherTenant.name).toBe("Café Offer");
    const renamed = await updateGeneratedEntityForTable(runtime.db, session, table, String(created[0]!.id), { name: "Renamed offer" });
    expect(renamed?.name).toBe("Renamed offer");
    expect(renamed?.key).toBe(created[0]!.key);
  }, 30_000);
});
