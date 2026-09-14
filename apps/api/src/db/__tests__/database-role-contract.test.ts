// SPDX-License-Identifier: BUSL-1.1
/**
 * The database role contract on the boundary a managed instance enforces:
 * the migrate role has neither SUPERUSER nor CREATEROLE. The chain must
 * refuse with the complete administrator remedy when the contract is not
 * met, and run to completion once the host has provisioned the roles.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { DATABASE_ROLES, databaseRole, provisionDatabaseRoles, renderProvisioningSql, verifyDatabaseRoles } from "../database-roles.js";
import { runMigrationChain } from "../migration-chain.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const migratorRole = `osf_contract_migrator_${suffix}`;
const scratchDatabase = `role_contract_${suffix}`;
const migratorPassword = `contract-${suffix}`;
const TEST_TIMEOUT = 120_000;

let admin: SQL;
let adminRuntime: DatabaseRuntime;
let migrator: DatabaseRuntime;

function url(user: string, password: string): string {
  const next = new URL(ADMIN_URL);
  next.username = user;
  next.password = password;
  next.pathname = `/${scratchDatabase}`;
  return next.toString();
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`
    create role ${migratorRole} login password '${migratorPassword}'
      nosuperuser nocreaterole nocreatedb nobypassrls;
  `);
  await admin.unsafe(`create database ${scratchDatabase} owner ${migratorRole}`);
  adminRuntime = createDatabaseRuntime({ databaseUrl: url(new URL(ADMIN_URL).username, new URL(ADMIN_URL).password), maxConnections: 1 });
  migrator = createDatabaseRuntime({ databaseUrl: url(migratorRole, migratorPassword), maxConnections: 1 });
}, TEST_TIMEOUT);

afterAll(async () => {
  await migrator?.close();
  await adminRuntime?.close();
  // Membership is cluster-wide; leave the shared roles as they were.
  await admin?.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
  await admin?.unsafe(`drop role if exists ${migratorRole}`);
  await admin?.close();
});

describe("database role contract", () => {
  test("the manifest declares the app, worker and definer roles", () => {
    expect(DATABASE_ROLES.map((role) => role.key).sort()).toEqual(["app", "blueprintReader", "worker"]);
    expect(databaseRole("blueprintReader")).toMatchObject({ login: false, migratorMember: true });
    const rendered = renderProvisioningSql({ migratorRole: "some_migrator" });
    expect(rendered).toContain("create role openshapeforge_blueprint_reader nologin");
    expect(rendered).toContain("grant openshapeforge_blueprint_reader to some_migrator;");
    expect(rendered).not.toMatch(/password '(?!<set-by-operator>)/);
  });

  test("a restricted migrator is refused before any schema exists, with the remedy", async () => {
    const error = await migrator.db.connection().execute((db) => runMigrationChain(db)).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain("Database role contract is not satisfied");
    expect(error?.message).toContain(`migrate role ${migratorRole} is not a member of openshapeforge_blueprint_reader`);
    expect(error?.message).toContain(`grant openshapeforge_blueprint_reader to ${migratorRole};`);
    const schemas = await migrator.db.connection().execute((db) =>
      sql<{ n: number }>`select count(*)::int as n from pg_namespace where nspname in ('app', 'platform')`.execute(db),
    );
    expect(schemas.rows[0]?.n).toBe(0);
  }, TEST_TIMEOUT);

  test("after the host provisions the roles the restricted migrator runs the whole chain", async () => {
    const provisioned = await adminRuntime.db.connection().execute((db) =>
      provisionDatabaseRoles(db, {
        passwords: { app: "openshapeforge_app", worker: "openshapeforge_worker" },
        migratorRole,
      }),
    );
    expect(provisioned.granted).toContain(`openshapeforge_blueprint_reader -> ${migratorRole}`);
    await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
    const result = await migrator.db.connection().execute((db) => runMigrationChain(db));
    expect(result.pageConfigs).toBeDefined();
    const owner = await migrator.db.connection().execute((db) =>
      sql<{ owner: string; create: boolean }>`
        select proowner::regrole::text as owner,
          has_schema_privilege('openshapeforge_blueprint_reader', 'app', 'CREATE') as "create"
        from pg_proc where proname = 'read_blueprints'
      `.execute(db),
    );
    expect(owner.rows[0]).toEqual({ owner: "openshapeforge_blueprint_reader", create: false });
    // Provisioning again changes nothing.
    const again = await adminRuntime.db.connection().execute((db) =>
      provisionDatabaseRoles(db, { passwords: {}, migratorRole }),
    );
    expect(again.created).toEqual([]);
    expect(again.granted).toEqual([]);
  }, TEST_TIMEOUT);
});
