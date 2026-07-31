// SPDX-License-Identifier: BUSL-1.1
/**
 * Stage 3 gate: cross-tenant access to connector state is impossible at the
 * DATABASE layer, not merely filtered by the application.
 *
 * Connector installations hold configuration for other people's systems and
 * point at encrypted credentials; connector_secrets holds the ciphertext; and
 * connector_entitlements decides what a tenant may use at all. If any of these
 * leaked across tenants, the application-layer connector API would be the only
 * thing standing between tenants — which is exactly the assumption
 * `FORCE ROW LEVEL SECURITY` exists to remove.
 *
 * Method, matching rls-enforcement.test.ts: run the migration chain against a
 * throwaway scratch database, connect AS the restricted openshapeforge_app role,
 * and issue RAW counts carrying NO tenant predicate. A 0 is proof RLS blocked
 * the read; anything else means a policy is missing or the role regained bypass.
 *
 * Run (cwd apps/api, needs the compose Postgres up):
 *   set -o pipefail; bun test src/db/__tests__/connector-tenant-isolation.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

function scratchAdminUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

function scratchAppUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PASSWORD;
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `connector_isolation_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(name);
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

describe("connector state is tenant-isolated by RLS", () => {
  test(
    "installations, secrets and entitlements are invisible across tenants",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), (db) =>
          db.connection().execute((conn) => runMigrationChain(conn)),
        );

        await withDb(scratchAppUrl(name), async (db) => {
          const superuser = await sql<{ is_superuser: string }>`
            select current_setting('is_superuser') as is_superuser
          `.execute(db);
          expect(superuser.rows[0]?.is_superuser).toBe("off");

          const tenantA = randomUUID();
          const tenantB = randomUUID();
          const slug = `probe-${randomUUID().slice(0, 8)}`;
          const entitlement = `connector.${slug}`;

          await db.connection().execute(async (conn) => {
            await sql`select set_config('app.tenant_id', ${tenantA}, false)`.execute(conn);

            const installation = randomUUID();
            await sql`
              insert into platform.connector_installations
                (id, tenant_id, connector_slug, instance_key, config, enabled,
                 contract_version, contract_checksum)
              values (${installation}::uuid, ${tenantA}::uuid, ${slug}, 'default',
                      '{}'::jsonb, true, 1, ${"checksum-a"})
            `.execute(conn);

            await sql`
              insert into platform.connector_secrets
                (id, tenant_id, installation_id, field_key, ciphertext, key_id, algorithm)
              values (gen_random_uuid(), ${tenantA}::uuid, ${installation}::uuid,
                      'apiKey', ${"ciphertext-a"}, 'k1', 'aes-256-gcm')
            `.execute(conn);

            await sql`
              insert into platform.connector_entitlements (id, tenant_id, entitlement)
              values (gen_random_uuid(), ${tenantA}::uuid, ${entitlement})
            `.execute(conn);

            // Sanity: tenant A sees its own rows.
            const own = await sql<{ installations: number; secrets: number; grants: number }>`
              select
                (select count(*)::int from platform.connector_installations
                   where connector_slug = ${slug}) as installations,
                (select count(*)::int from platform.connector_secrets
                   where ciphertext = ${"ciphertext-a"}) as secrets,
                (select count(*)::int from platform.connector_entitlements
                   where entitlement = ${entitlement}) as grants
            `.execute(conn);
            expect(own.rows[0]).toEqual({ installations: 1, secrets: 1, grants: 1 });

            // Switch tenants and run the SAME raw counts, with no tenant
            // predicate. RLS must hide all three.
            await sql`select set_config('app.tenant_id', ${tenantB}, false)`.execute(conn);
            const other = await sql<{ installations: number; secrets: number; grants: number }>`
              select
                (select count(*)::int from platform.connector_installations
                   where connector_slug = ${slug}) as installations,
                (select count(*)::int from platform.connector_secrets
                   where ciphertext = ${"ciphertext-a"}) as secrets,
                (select count(*)::int from platform.connector_entitlements
                   where entitlement = ${entitlement}) as grants
            `.execute(conn);
            expect(other.rows[0]).toEqual({ installations: 0, secrets: 0, grants: 0 });
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  /**
   * A tenant must not be able to forge an entitlement for itself by writing a
   * row attributed to another tenant, nor plant configuration in someone else's
   * account. WITH CHECK on the tenant policy is what stops the write.
   */
  test(
    "a tenant cannot write connector rows attributed to another tenant",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), (db) =>
          db.connection().execute((conn) => runMigrationChain(conn)),
        );

        await withDb(scratchAppUrl(name), async (db) => {
          const tenantA = randomUUID();
          const tenantB = randomUUID();

          await db.connection().execute(async (conn) => {
            await sql`select set_config('app.tenant_id', ${tenantA}, false)`.execute(conn);

            // Assert on the REASON, not merely that something threw: a bare
            // rejects.toThrow() would pass just as happily on a NOT NULL
            // violation or a typo, and would keep passing if the policy were
            // dropped and some unrelated constraint took over.
            await expect(
              sql`
                insert into platform.connector_entitlements (id, tenant_id, entitlement)
                values (gen_random_uuid(), ${tenantB}::uuid, ${"connector.stolen"})
              `.execute(conn),
            ).rejects.toThrow(/violates row-level security policy/);

            await expect(
              sql`
                insert into platform.connector_installations
                  (id, tenant_id, connector_slug, instance_key, config, enabled,
                   contract_version, contract_checksum)
                values (gen_random_uuid(), ${tenantB}::uuid, 'planted', 'default',
                        '{}'::jsonb, true, 1, 'x')
              `.execute(conn),
            ).rejects.toThrow(/violates row-level security policy/);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );
});
