// SPDX-License-Identifier: BUSL-1.1
/**
 * The restricted `openshapeforge_app` role can NAME the `app` schema, on a
 * database that was migrated from empty (#295).
 *
 * `applyAppRoleMigration` runs FIRST in the chain — before `app` exists — so
 * every grant it issues is guarded on the schema being present, and on a fresh
 * migrate the `app` guard is false. The role was left holding EXECUTE on the
 * RLS helpers (functions grant EXECUTE to PUBLIC by default) with no USAGE on
 * the schema that contains them, so any application statement naming `app.…`
 * failed with `permission denied for schema app`.
 *
 * RLS was never affected — PostgreSQL evaluates policy expressions with the
 * table OWNER's privileges, so `tenant_id = app.current_tenant()` inside a
 * policy works for a role that cannot name the function. This file covers the
 * other direction, and the FRESH database is the whole point: a scratch DB
 * where `app` did not pre-exist is the only shape that reproduces it.
 *
 * The negative half matters as much as the positive one. This role is
 * deliberately narrow (NOSUPERUSER, NOBYPASSRLS), and "make the grant work" is
 * one careless GRANT away from handing it CREATE on the schema that defines
 * every RLS helper.
 *
 * One scratch database, migrated once in beforeAll and shared by all three
 * tests (bun runs tests in a file sequentially), as schema-drift.test.ts does.
 * Nothing here mutates the grants, and the chain writes the CLUSTER-WIDE role
 * row on every run — so re-migrating per test would only add contention with
 * whatever else is using the same Postgres.
 *
 * Run (cwd apps/api, needs the compose Postgres up):
 *   set -o pipefail; bun test src/db/__tests__/app-role-schema-grants.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

const scratchName = `app_role_grants_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
if (!/^[a-z0-9_]+$/.test(scratchName)) {
  throw new Error(`unsafe scratch database name: ${scratchName}`);
}

/** The scratch DB as the PRIVILEGED role the migrate chain needs. */
function scratchAdminUrl(): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

/** The same scratch DB, connecting AS the restricted openshapeforge_app role. */
function scratchAppUrl(): string {
  const url = new URL(ADMIN_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PASSWORD;
  url.pathname = `/${scratchName}`;
  return url.toString();
}

let admin: SQL;
/** Privileged connection — a superuser, so it bypasses every policy. */
let privileged: DatabaseRuntime;
/** Restricted connection — what the app runtime actually uses. */
let restricted: DatabaseRuntime;

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  privileged = createDatabaseRuntime({
    databaseUrl: scratchAdminUrl(),
    maxConnections: 2,
  });
  // Migrate from EMPTY, exactly as migrate.ts does: connection-bound.
  await privileged.db.connection().execute((conn) => runMigrationChain(conn));
  restricted = createDatabaseRuntime({ databaseUrl: scratchAppUrl(), maxConnections: 2 });
}, TEST_TIMEOUT);

afterAll(async () => {
  await restricted?.close();
  await privileged?.close();
  // FORCE (Postgres 13+) kills any straggling scratch connections.
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("app role grants on a freshly migrated database", () => {
  test(
    "the restricted role holds USAGE — and only USAGE — on schema app",
    async () => {
      const privileges = await sql<{ usage: boolean; may_create: boolean }>`
        select
          has_schema_privilege(${APP_ROLE}, 'app', 'USAGE') as usage,
          has_schema_privilege(${APP_ROLE}, 'app', 'CREATE') as may_create
      `.execute(privileged.db);

      expect(privileges.rows[0]?.usage).toBe(true);
      // Not widened: USAGE plus the EXECUTE the chain already grants is the
      // whole target. CREATE would let the restricted role define its own
      // objects alongside the RLS helpers every policy resolves through.
      expect(privileges.rows[0]?.may_create).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "the restricted role can call the app.* RLS helpers by name",
    async () => {
      // Guard the guard: as a superuser the privilege checks above would be
      // vacuously true and the call below would succeed for the wrong reason.
      const superuser = await sql<{ is_superuser: string }>`
        select current_setting('is_superuser') as is_superuser
      `.execute(restricted.db);
      expect(superuser.rows[0]?.is_superuser).toBe("off");

      // Fails with `permission denied for schema app` without the fix.
      const tenantId = randomUUID();
      const helper = await restricted.db.connection().execute(async (conn) => {
        await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(conn);
        return sql<{ tenant: string | null }>`
          select app.current_tenant()::text as tenant
        `.execute(conn);
      });
      expect(helper.rows[0]?.tenant).toBe(tenantId);
    },
    TEST_TIMEOUT,
  );

  test(
    "application SQL may use app.current_tenant() in its own predicate",
    async () => {
      // The shape #293 hit: a resolver predicate naming the helper directly.
      // Seeded privileged, which bypasses the registry's policy.
      const slug = `probe-${randomUUID().slice(0, 8)}`;
      const inserted = await sql<{ id: string }>`
        insert into platform.tenants (slug, name, status)
        values (${slug}, ${"Probe"}, ${"active"})
        returning id::text
      `.execute(privileged.db);
      const tenantId = inserted.rows[0]!.id;

      const rows = await restricted.db.connection().execute(async (conn) => {
        await sql`select set_config('app.tenant_id', ${tenantId}, false)`.execute(conn);
        return sql<{ slug: string }>`
          select slug from platform.tenants where id = app.current_tenant()
        `.execute(conn);
      });

      expect(rows.rows.map((row) => row.slug)).toEqual([slug]);
    },
    TEST_TIMEOUT,
  );
});
