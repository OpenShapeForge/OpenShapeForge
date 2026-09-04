// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { APP_ROLE, applyAppRoleMigration } from "../migrations/app-role.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const migratorRole = `osf_managed_migrator_${suffix}`;
const scratchDatabase = `managed_role_${suffix}`;
const migratorPassword = `managed-${suffix}`;
const TEST_TIMEOUT = 30_000;
if (!/^[a-z0-9_]+$/.test(migratorRole) || !/^[a-z0-9_]+$/.test(scratchDatabase)) {
  throw new Error("unsafe managed-role test identifier");
}

let admin: SQL;
let managedMigrator: DatabaseRuntime;

function migratorUrl(): string {
  const url = new URL(ADMIN_URL);
  url.username = migratorRole;
  url.password = migratorPassword;
  url.pathname = `/${scratchDatabase}`;
  return url.toString();
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login nosuperuser nobypassrls;
      else
        alter role ${APP_ROLE} login nosuperuser nobypassrls;
      end if;
    end
    $$;
    create role ${migratorRole}
      login password '${migratorPassword}'
      createdb createrole nosuperuser nobypassrls;
  `);
  await admin.unsafe(`create database ${scratchDatabase} owner ${migratorRole}`);
  managedMigrator = createDatabaseRuntime({ databaseUrl: migratorUrl(), maxConnections: 1 });
}, TEST_TIMEOUT);

afterAll(async () => {
  await managedMigrator?.close();
  await admin?.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
  await admin?.unsafe(`drop role if exists ${migratorRole}`);
  await admin?.close();
});

describe("managed Postgres role reconciliation", () => {
  test(
    "does not require superuser when the runtime role is already safe",
    async () => {
      await managedMigrator.db.connection().execute((connection) =>
        applyAppRoleMigration(connection),
      );

      const identity = await sql<{ superuser: boolean; createRole: boolean }>`
        select rolsuper as superuser, rolcreaterole as "createRole"
        from pg_roles
        where rolname = ${migratorRole}
      `.execute(managedMigrator.db);
      expect(identity.rows[0]?.superuser).toBe(false);
      expect(identity.rows[0]?.createRole).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
