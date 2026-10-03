// SPDX-License-Identifier: BUSL-1.1
/**
 * Migration-chain tests. Every scenario runs the real chain (roles -> app
 * helpers -> generated schema -> core invariants -> grants -> seeds) against
 * a throwaway SCRATCH database created and dropped through the admin URL on
 * the same Postgres instance. The live openshapeforge_dev database is never
 * touched.
 *
 * The reset model under test: an empty database is built, a built one with
 * the bundled checksum is left alone, and a built one with any other
 * checksum is refused — nothing rolls a database forward.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { type Kysely, sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { generatedSchemaMigrationVersion } from "../migrations/generated-schema.js";
import { ensureCheckConstraint } from "../migrations/sql-invariants.js";
import { findUndeclaredDatabaseSchema } from "../schema-drift.js";

// The migration chain now provisions the cluster-wide openshapeforge_app role and
// issues GRANTs, so the admin connection MUST be the privileged (superuser)
// role — the `postgres` maintenance DB owned by `openshapeforge`, which is exactly
// the default below. DATABASE_URL (the restricted runtime role) must NOT be
// used here; scratch-DB creation and CREATE ROLE require the privileged role.
const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const name = `migrations_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(scratchUrl(name));
    } finally {
      // FORCE (Postgres 13+) kills any straggling scratch connections.
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({
    databaseUrl: url,
    maxConnections: 1,
  });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

/** Runs the full migration chain the way migrate.ts does: connection-bound. */
async function runChain(url: string) {
  return withDb(url, (db) => db.connection().execute((conn) => runMigrationChain(conn)));
}

async function tableExists(db: Kysely<DB>, schema: string, table: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = ${table}
        and table_type = 'BASE TABLE'
    ) as present
  `.execute(db);
  return result.rows[0]?.present ?? false;
}

async function columnExists(
  db: Kysely<DB>,
  schema: string,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select exists (
      select 1 from information_schema.columns
      where table_schema = ${schema} and table_name = ${table}
        and column_name = ${column}
    ) as present
  `.execute(db);
  return result.rows[0]?.present ?? false;
}

async function recordedChecksum(db: Kysely<DB>, version: string): Promise<string | null> {
  const result = await sql<{ checksum: string }>`
    select checksum from platform.schema_migrations where version = ${version}
  `.execute(db);
  return result.rows[0]?.checksum ?? null;
}

async function expectRejects(promise: Promise<unknown>): Promise<string> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("generated schema migration", () => {
  test(
    "fresh install applies schema.sql, records the checksum, and no-ops on rerun",
    async () => {
      await withScratchDb(async (url) => {
        const first = await runChain(url);
        expect(first.applied).toBe(true);
        expect(first.checksum).toBe(manifest.checksum);
        expect(first.pluginMigrationsApplied.length).toBeGreaterThan(0);

        await withDb(url, async (db) => {
          // The ledger holds the generated-schema record and nothing else:
          // plugin DDL is applied on every run, not remembered.
          const ledger = await sql<{ version: string }>`
            select version from platform.schema_migrations order by version
          `.execute(db);
          expect(ledger.rows.map((row) => row.version)).toEqual([
            generatedSchemaMigrationVersion,
          ]);
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe(
            manifest.checksum,
          );
          expect(await tableExists(db, "erp", "relations")).toBe(true);
          expect(await tableExists(db, "platform", "tenants")).toBe(true);
          expect(await tableExists(db, "platform", "org_unit")).toBe(true);
          expect(await tableExists(db, "platform", "org_unit_closure")).toBe(true);
          expect(await columnExists(db, "platform", "org_unit", "slug")).toBe(true);
          expect(await columnExists(db, "platform", "org_unit", "keycloak_organization_id")).toBe(
            true,
          );
        });

        const second = await runChain(url);
        expect(second.applied).toBe(false);
        expect(second.checksum).toBe(manifest.checksum);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a fresh install creates every table from the manifest and nothing beside it",
    async () => {
      // The reset-model invariant: one declared source of truth per table.
      // After the chain, every schema object in a manifest-covered schema is
      // one the manifest declares (the runtime bookkeeping tables included),
      // and every declared column matches the live one in type, nullability
      // and default — so a reset builds exactly what the manifest says and
      // drift detection has nothing to exempt.
      await withScratchDb(async (url) => {
        await runChain(url);

        await withDb(url, async (db) => {
          expect(await findUndeclaredDatabaseSchema(db)).toEqual({ tables: [], columns: [] });

          // The runtime-owned platform tables that used to be created by
          // their own migration files now come from platform-schema.yaml,
          // composite keys and text arrays included.
          for (const table of [
            "system_bypass_audit",
            "identities",
            "identity_relations",
            "employee_invitations",
            "capability_grants",
            "update_notices",
            "user_update_notices",
            "operation_execution_receipts",
            "blueprint_libraries",
            "blueprint_versions",
            "blueprint_copies",
          ]) {
            expect(await tableExists(db, "platform", table)).toBe(true);
          }
          const keys = await sql<{ table: string; columns: string[] }>`
            select c.conrelid::regclass::text as "table",
              array_agg(a.attname order by k.ordinality) as columns
            from pg_constraint c
            cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
            where c.contype = 'p'
              and c.conrelid in (
                'platform.identity_relations'::regclass,
                'platform.blueprint_versions'::regclass,
                'platform.operation_execution_receipts'::regclass
              )
            group by c.conrelid
            order by 1
          `.execute(db);
          expect(keys.rows).toEqual([
            { table: "platform.blueprint_versions", columns: ["tenant_id", "entity_name", "blueprint_id", "version"] },
            { table: "platform.identity_relations", columns: ["identity_id", "tenant_id"] },
            {
              table: "platform.operation_execution_receipts",
              columns: ["tenant_id", "actor_id", "operation_id", "operation_intent", "key_hash"],
            },
          ]);
          expect(await columnExists(db, "platform", "identity_relations", "onboarding_guides_read")).toBe(true);
          expect(await columnExists(db, "platform", "tenants", "relation_id")).toBe(true);

          // Every reference into a tenant-scoped table binds the tenant on
          // both sides: a foreign-key check bypasses row-level security, so
          // the key shape is what keeps another tenant's row unreachable.
          const tenantBound = await sql<{ name: string; columns: string[]; target: string[] }>`
            select c.conname as name,
              (select array_agg(a.attname order by k.ordinality)
                 from unnest(c.conkey) with ordinality as k(attnum, ordinality)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns,
              (select array_agg(a.attname order by k.ordinality)
                 from unnest(c.confkey) with ordinality as k(attnum, ordinality)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as target
            from pg_constraint c
            where c.contype = 'f' and c.conname in (
              'tenants_relation_id_fkey',
              'identity_relations_relation_id_fkey',
              'identity_relations_candidate_relation_id_fkey',
              'org_unit_parent_id_fkey',
              'api_keys_integration_id_fkey',
              'connector_secrets_installation_id_fkey',
              'jobs_tenant_id_fkey'
            )
            order by 1
          `.execute(db);
          expect(tenantBound.rows).toEqual([
            { name: "api_keys_integration_id_fkey", columns: ["tenant_id", "integration_id"], target: ["tenant_id", "id"] },
            { name: "connector_secrets_installation_id_fkey", columns: ["tenant_id", "installation_id"], target: ["tenant_id", "id"] },
            { name: "identity_relations_candidate_relation_id_fkey", columns: ["tenant_id", "candidate_relation_id"], target: ["tenant_id", "id"] },
            { name: "identity_relations_relation_id_fkey", columns: ["tenant_id", "relation_id"], target: ["tenant_id", "id"] },
            { name: "jobs_tenant_id_fkey", columns: ["tenant_id"], target: ["id"] },
            { name: "org_unit_parent_id_fkey", columns: ["tenant_id", "parent_id"], target: ["tenant_id", "id"] },
            { name: "tenants_relation_id_fkey", columns: ["id", "relation_id"], target: ["tenant_id", "id"] },
          ]);

          // What the migration files still own: the invariants the manifest
          // cannot express, present after the chain and idempotent on rerun.
          const invariants = await sql<{ name: string }>`
            select conname as name from pg_constraint
            where conname in (
              'capability_grants_max_uses_check',
              'identity_relations_status_shape',
              'employee_invitations_status_shape',
              'operation_execution_receipts_state_shape',
              'blueprint_copies_source_version_fkey'
            )
            order by 1
          `.execute(db);
          expect(invariants.rows.map((row) => row.name)).toEqual([
            "blueprint_copies_source_version_fkey",
            "capability_grants_max_uses_check",
            "employee_invitations_status_shape",
            "identity_relations_status_shape",
            "operation_execution_receipts_state_shape",
          ]);
          const policies = await sql<{ policyname: string }>`
            select policyname from pg_policies
            where schemaname = 'platform'
              and policyname in (
                'identities_visibility',
                'identity_relations_tenant_isolation',
                'employee_invitations_tenant_isolation',
                'update_notices_readable',
                'user_update_notices_tenant_isolation',
                'operation_execution_receipts_actor_scope',
                'blueprint_versions_publish',
                'tenants_relation_link_write'
              )
          `.execute(db);
          expect(policies.rows).toHaveLength(8);
        });

        // Rerunning the chain re-applies every invariant without complaint.
        const again = await runChain(url);
        expect(again.applied).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a checksum mismatch is refused with the db:reset remediation and changes nothing",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        // A database built from another manifest: a column the bundled
        // manifest declares is missing, and the recorded checksum differs.
        // Whether the difference would have been "additive" is irrelevant —
        // the chain never looks.
        await withDb(url, async (db) => {
          await sql`alter table erp.relations drop column notes`.execute(db);
          await sql`
            update platform.schema_migrations
            set checksum = ${"built-from-another-manifest"}
            where version = ${generatedSchemaMigrationVersion}
          `.execute(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("Generated schema checksum mismatch");
        expect(message).toContain("built-from-another-manifest");
        expect(message).toContain(manifest.checksum);
        expect(message).toContain("`bun run db:reset`");

        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe(
            "built-from-another-manifest",
          );
          expect(await columnExists(db, "erp", "relations", "notes")).toBe(false);
        });

        // Still refused on every later run: nothing rolls forward.
        expect(await expectRejects(runChain(url))).toContain("`bun run db:reset`");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a database with no generated-schema row but leftover tables is refused, and no checksum is written",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          await sql`create schema erp`.execute(db);
          await sql`create table erp.legacy_relations (id uuid primary key)`.execute(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("no generated-schema record but is not empty");
        expect(message).toContain("  - table  erp.legacy_relations");
        expect(message).toContain("`bun run db:reset`");

        await withDb(url, async (db) => {
          expect(await tableExists(db, "platform", "schema_migrations")).toBe(false);
          expect(await tableExists(db, "erp", "relations")).toBe(false);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a declared table left behind without a generated-schema row is refused too",
    async () => {
      // CREATE IF NOT EXISTS would silently adopt it and stamp the checksum
      // onto a table nobody verified.
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          await sql`create schema erp`.execute(db);
          await sql`create table erp.relations (id uuid primary key)`.execute(db);
        });
        const message = await expectRejects(runChain(url));
        expect(message).toContain("  - table  erp.relations");
        await withDb(url, async (db) => {
          expect(await tableExists(db, "platform", "schema_migrations")).toBe(false);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a built database with a matching checksum is still refused when it carries undeclared schema",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        await withDb(url, async (db) => {
          await sql`alter table erp.relations add column legacy_extra text`.execute(db);
        });
        const message = await expectRejects(runChain(url));
        expect(message).toContain("schema the manifest does not declare");
        expect(message).toContain("  - column erp.relations.legacy_extra");
        expect(message).toContain("`bun run db:reset`");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a table the manifest does not declare is reported as foreign, with no exemption",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        await withDb(url, async (db) => {
          // A leftover of another repository's plugin in a manifest-covered
          // schema, and a stray column on a declared table.
          await sql`create table platform.retired_plugin_data (id uuid primary key)`.execute(db);
          await sql`alter table erp.relations add column legacy_extra text`.execute(db);
          expect(await findUndeclaredDatabaseSchema(db)).toEqual({
            tables: ["platform.retired_plugin_data"],
            columns: ["erp.relations.legacy_extra"],
          });
        });
      });
    },
    TEST_TIMEOUT,
  );
});

describe("hand-written check invariants", () => {
  test(
    "a changed CHECK definition is replaced in place; an unchanged one is left alone",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          await sql`create schema invariant_probe`.execute(db);
          await sql`create table invariant_probe.tickets (status text not null)`.execute(db);
          await sql`insert into invariant_probe.tickets values ('open'), ('closed')`.execute(db);
          const constraint = { table: "invariant_probe.tickets", name: "tickets_status_shape" };
          const current = async () => (
            await sql<{ oid: number; definition: string }>`
              select oid, pg_get_constraintdef(oid) as definition
              from pg_constraint
              where conrelid = 'invariant_probe.tickets'::regclass
                and conname = 'tickets_status_shape'
            `.execute(db)
          ).rows;

          await ensureCheckConstraint(db, { ...constraint, expression: "status in ('open', 'closed')" });
          const [added] = await current();
          expect(added?.definition).toContain("'closed'");

          // Same expression, spelled as authored: the canonical definitions
          // agree, so the constraint is not touched (same catalog row).
          await ensureCheckConstraint(db, { ...constraint, expression: "status in ('open', 'closed')" });
          expect((await current())[0]?.oid).toBe(added!.oid);

          // A widened expression differs from what the database holds: the
          // constraint is dropped and re-added under the same name.
          await ensureCheckConstraint(db, {
            ...constraint,
            expression: "status in ('open', 'closed', 'archived')",
          });
          const [replaced] = await current();
          expect(replaced?.oid).not.toBe(added!.oid);
          expect(replaced?.definition).toContain("'archived'");
          await sql`insert into invariant_probe.tickets values ('archived')`.execute(db);

          // A narrowed expression the rows violate is refused by Postgres,
          // and the previous constraint is still in place.
          await expect(
            ensureCheckConstraint(db, { ...constraint, expression: "status in ('open')" }),
          ).rejects.toThrow(/violated/);
          expect((await current())[0]?.definition).toContain("'archived'");

          // The probe never survives.
          const probes = await sql<{ conname: string }>`
            select conname from pg_constraint where conname like '%probe%'
          `.execute(db);
          expect(probes.rows).toEqual([]);
        });
      });
    },
    TEST_TIMEOUT,
  );
});
