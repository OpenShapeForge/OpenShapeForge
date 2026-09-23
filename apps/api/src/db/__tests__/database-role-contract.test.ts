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
import {
  DATABASE_ROLES,
  databaseRole,
  provisionDatabaseRoles,
  renderProvisioningSql,
  verifyDatabaseRoles,
  type DatabaseRoleContract,
} from "../database-roles.js";
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
    expect(DATABASE_ROLES.map((role) => role.key).sort()).toEqual([
      "app",
      "blueprintReader",
      "identityResolver",
      "worker",
    ]);
    expect(databaseRole("blueprintReader")).toMatchObject({ login: false, migratorMember: true });
    expect(databaseRole("identityResolver")).toMatchObject({ login: false, migratorMember: true });
    const rendered = renderProvisioningSql({ migratorRole: "some_migrator" });
    expect(rendered).toContain("create role openshapeforge_blueprint_reader nologin");
    expect(rendered).toContain(
      "grant openshapeforge_blueprint_reader to some_migrator with inherit true, set true;",
    );
    expect(rendered).not.toMatch(/password '(?!<set-by-operator>)/);
  });

  test("a restricted migrator is refused before any schema exists, with the remedy", async () => {
    const error = await migrator.db.connection().execute((db) => runMigrationChain(db)).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain("Database role contract is not satisfied");
    expect(error?.message).toContain(`migrate role ${migratorRole} is not a member of openshapeforge_blueprint_reader`);
    expect(error?.message).toContain(
      `grant openshapeforge_blueprint_reader to ${migratorRole} with inherit true, set true;`,
    );
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
    expect(again.rotated).toEqual([]);
    expect(again.granted).toEqual([]);
  }, TEST_TIMEOUT);

  test("explicit password rotation uses the administrator connection", async () => {
    const rotatedAppPassword = `app-${suffix}`;
    const rotatedWorkerPassword = `worker-${suffix}`;
    try {
      const rotated = await adminRuntime.db.connection().execute((db) =>
        provisionDatabaseRoles(db, {
          passwords: { app: rotatedAppPassword, worker: rotatedWorkerPassword },
          rotatePasswords: { app: true, worker: true },
          migratorRole,
        }),
      );
      expect(rotated.rotated.sort()).toEqual([
        databaseRole("app").name,
        databaseRole("worker").name,
      ].sort());

      for (const [role, password] of [
        [databaseRole("app").name, rotatedAppPassword],
        [databaseRole("worker").name, rotatedWorkerPassword],
      ] as const) {
        const connection = new SQL(url(role, password), { max: 1 });
        try {
          expect((await connection`select current_user as "user"`)[0]?.user).toBe(role);
        } finally {
          await connection.close();
        }
      }
    } finally {
      await adminRuntime.db.connection().execute((db) =>
        provisionDatabaseRoles(db, {
          passwords: { app: "openshapeforge_app", worker: "openshapeforge_worker" },
          rotatePasswords: { app: true, worker: true },
          migratorRole,
        }),
      );
    }
  }, TEST_TIMEOUT);

  test("repairs a PostgreSQL 16+ CREATEROLE self-grant into usable membership", async () => {
    const creatorRole = `osf_contract_creator_${suffix}`;
    const childRole = `osf_contract_child_${suffix}`;
    const creatorPassword = `creator-${suffix}`;
    const contracts = DATABASE_ROLES as DatabaseRoleContract[];
    const originalContracts = [...contracts];
    let creator: DatabaseRuntime | undefined;
    try {
      await admin.unsafe(`
        create role ${creatorRole} login password '${creatorPassword}'
          createrole noinherit nosuperuser nocreatedb nobypassrls;
      `);
      creator = createDatabaseRuntime({
        databaseUrl: url(creatorRole, creatorPassword),
        maxConnections: 1,
      });
      await creator.db.connection().execute((db) =>
        sql`set createrole_self_grant = 'inherit'`.execute(db),
      );
      contracts.splice(0, contracts.length, {
        key: "blueprintReader",
        name: childRole,
        login: false,
        migratorMember: true,
        purpose: "exercise PostgreSQL CREATEROLE self-grant semantics",
      });

      const provisioned = await creator.db.connection().execute((db) =>
        provisionDatabaseRoles(db, { passwords: {}, migratorRole: creatorRole }),
      );
      expect(provisioned.created).toEqual([childRole]);
      expect(provisioned.granted).toEqual([`${childRole} -> ${creatorRole}`]);
      await creator.db.connection().execute((db) => verifyDatabaseRoles(db));
      const capabilities = await creator.db.connection().execute((db) =>
        sql<{ usage: boolean; canSet: boolean }>`
          select pg_has_role(current_user, ${childRole}, 'USAGE') as usage,
            pg_has_role(current_user, ${childRole}, 'SET') as "canSet"
        `.execute(db),
      );
      expect(capabilities.rows[0]).toEqual({ usage: true, canSet: true });
    } finally {
      contracts.splice(0, contracts.length, ...originalContracts);
      await creator?.close();
      await admin.unsafe(`drop role if exists ${childRole}`);
      await admin.unsafe(`drop role if exists ${creatorRole}`);
    }
  }, TEST_TIMEOUT);
});
