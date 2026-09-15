// SPDX-License-Identifier: BUSL-1.1
/**
 * Migration-chain tests. Every scenario runs the real chain (roles -> app
 * helpers -> generated schema -> core invariants -> grants -> seeds) against
 * a throwaway SCRATCH database created and dropped through the admin URL on
 * the same Postgres instance. The live openshapeforge_dev database is never
 * touched.
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
import {
  diffManifestAgainstDatabase,
  generatedSchemaMigrationVersion,
  type ManifestColumn,
  type ManifestTable,
} from "../migrations/generated-schema.js";
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
        expect(first.rollForward).toBeUndefined();

        await withDb(url, async (db) => {
          // The ledger holds the generated-schema record and nothing else: no
          // hand-written history is replayed on the way to a built database.
          const ledger = await sql<{ version: string }>`
            select version from platform.schema_migrations order by version
          `.execute(db);
          expect(ledger.rows.map((row) => row.version)).toEqual([generatedSchemaMigrationVersion]);
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
          const diff = await diffManifestAgainstDatabase(db);
          expect(diff.nonAdditive).toEqual([]);
          expect(diff.missingTables).toEqual([]);
          expect(diff.missingColumns).toEqual([]);

          // The runtime-owned platform tables that used to be created by
          // their own migration files now come from platform-schema.yaml,
          // composite keys and text arrays included.
          for (const table of [
            "system_bypass_audit",
            "identities",
            "identity_relations",
            "employee_invitations",
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

          // What the migration files still own: the invariants the manifest
          // cannot express, present after the chain and idempotent on rerun.
          const invariants = await sql<{ name: string }>`
            select conname as name from pg_constraint
            where conname in (
              'identity_relations_status_shape',
              'employee_invitations_status_shape',
              'operation_execution_receipts_state_shape',
              'blueprint_copies_source_version_fkey',
              'tenants_relation_id_fkey',
              'identity_relations_relation_id_fkey'
            )
            order by 1
          `.execute(db);
          expect(invariants.rows.map((row) => row.name)).toEqual([
            "blueprint_copies_source_version_fkey",
            "employee_invitations_status_shape",
            "identity_relations_relation_id_fkey",
            "identity_relations_status_shape",
            "operation_execution_receipts_state_shape",
            "tenants_relation_id_fkey",
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
    "additive roll-forward: recreates a dropped table and column, rolls the checksum forward",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        // Simulate an OLD database: one table and one nullable column are
        // missing, and the recorded checksum is stale.
        await withDb(url, async (db) => {
          await sql`drop table platform.entity_field_suggestions`.execute(db);
          await sql`alter table erp.relations drop column notes`.execute(db);
          await sql`
            update platform.schema_migrations
            set checksum = ${"simulated-old"}
            where version = ${generatedSchemaMigrationVersion}
          `.execute(db);
        });

        const result = await runChain(url);
        expect(result.applied).toBe(true);
        expect(result.checksum).toBe(manifest.checksum);
        expect(result.rollForward?.addedTables).toEqual(["platform.entity_field_suggestions"]);
        expect(result.rollForward?.addedColumns).toEqual(["erp.relations.notes"]);

        await withDb(url, async (db) => {
          expect(await tableExists(db, "platform", "entity_field_suggestions")).toBe(true);
          expect(await columnExists(db, "erp", "relations", "notes")).toBe(true);
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe(
            manifest.checksum,
          );
        });

        const after = await runChain(url);
        expect(after.applied).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "non-additive drift: an extra database column hard-errors with exact details and records nothing",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        await withDb(url, async (db) => {
          await sql`alter table erp.relations add column legacy_extra text`.execute(db);
          await sql`
            update platform.schema_migrations
            set checksum = ${"simulated-old"}
            where version = ${generatedSchemaMigrationVersion}
          `.execute(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("erp.relations");
        expect(message).toContain("legacy_extra");
        expect(message).toContain("db:reset");

        // The failed run must not roll the checksum forward.
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe("simulated-old");
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "required no-default column is non-additive on a populated table, additive once empty",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        await withDb(url, async (db) => {
          await sql`
            insert into erp.relations (tenant_id, display_name, relation_type)
            values (gen_random_uuid(), ${"Populated"}, ${"person"})
          `.execute(db);
          await sql`alter table erp.relations drop column display_name`.execute(db);
          await sql`
            update platform.schema_migrations
            set checksum = ${"simulated-old"}
            where version = ${generatedSchemaMigrationVersion}
          `.execute(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("erp.relations.display_name");
        expect(message).toContain("backfill");

        // Same drift on an EMPTY table is additive.
        await withDb(url, async (db) => {
          await sql`delete from erp.relations`.execute(db);
        });
        const result = await runChain(url);
        expect(result.applied).toBe(true);
        expect(result.rollForward?.addedColumns).toEqual(["erp.relations.display_name"]);
        await withDb(url, async (db) => {
          expect(await columnExists(db, "erp", "relations", "display_name")).toBe(true);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "changed column default is non-additive drift and hard-errors without rolling forward",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        await withDb(url, async (db) => {
          // The manifest declares erp.relations.created_at DEFAULT now(); drift
          // it in the database to a different (but valid) default. The
          // roll-forward cannot ALTER a default in place, so it must surface
          // this as non-additive rather than silently keeping the stale one.
          await sql`
            alter table erp.relations alter column created_at set default now() - interval '1 day'
          `.execute(db);
          await sql`
            update platform.schema_migrations
            set checksum = ${"simulated-old"}
            where version = ${generatedSchemaMigrationVersion}
          `.execute(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("erp.relations.created_at");
        expect(message.toLowerCase()).toContain("default mismatch");
        expect(message).toContain("db:reset");

        // The failed run must not roll the checksum forward.
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe("simulated-old");
        });
      });
    },
    TEST_TIMEOUT,
  );
});

/**
 * Column-default drift (issue #210). The bundled manifest cannot exhibit both
 * spellings of the same default at once, so these tests drive the classifier
 * against a purpose-built schema instead — the `tables` parameter exists for
 * exactly that, the way MigrationChainOptions.pluginMigrations does for the chain.
 * The DDL below is written the way the generated schema.sql would render each
 * authoring spelling, so what is compared is a real live column, not a string.
 */
function probeColumn(
  name: string,
  type: string,
  columnDefault: string,
  overrides: Partial<ManifestColumn> = {},
): ManifestColumn {
  return {
    name,
    type,
    required: true,
    primaryKey: false,
    generated: null,
    default: columnDefault,
    ...overrides,
  };
}

describe("generated schema column defaults", () => {
  test(
    "a default authored without the redundant cast Postgres adds is not drift",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          // Every quoted default here is authored BARE in the DDL. Postgres
          // stores each one with a cast to the column type appended, so the
          // live column_default never matches the authored spelling verbatim.
          await sql`create schema drift_probe`.execute(db);
          await sql`
            create table drift_probe.equivalent_defaults (
              id uuid primary key default gen_random_uuid(),
              category text not null default 'process',
              quoted_label text not null default 'it''s',
              external_ref uuid not null default '00000000-0000-0000-0000-000000000001',
              payload jsonb not null default '{}',
              execution_state jsonb not null default '{"version":1,"branches":[],"groups":[],"joins":[],"primaryOutput":null}'::jsonb,
              effective_on date not null default '2020-01-01',
              instance_key text not null default 'default',
              wait_token text not null default (gen_random_uuid())::text,
              created_at timestamptz not null default now(),
              enabled boolean not null default false,
              attempts integer not null default 0
            )
          `.execute(db);

          const table: ManifestTable = {
            name: "drift_probe.equivalent_defaults",
            schema: "drift_probe",
            table: "equivalent_defaults",
            columns: [
              probeColumn("id", "uuid", "gen_random_uuid()", {
                primaryKey: true,
              }),
              // The issue's exact case: a text default with no ::text.
              probeColumn("category", "text", "'process'"),
              // Escaped quotes must survive the literal scan intact.
              probeColumn("quoted_label", "text", "'it''s'"),
              probeColumn("external_ref", "uuid", "'00000000-0000-0000-0000-000000000001'"),
              probeColumn("payload", "jsonb", "'{}'"),
              // jsonb discards object-key order and authored whitespace.
              probeColumn(
                "execution_state",
                "jsonb",
                '\'{"primaryOutput":null, "joins":[], "groups":[], "branches":[], "version":1}\'::jsonb',
              ),
              probeColumn("effective_on", "date", "'2020-01-01'"),
              // The other direction: authored WITH the cast, live column
              // created bare. Either spelling must compare equal to either.
              probeColumn("instance_key", "text", "'default'::text"),
              // Postgres may render the function operand with one extra pair
              // of parentheses before the same column-type cast.
              probeColumn("wait_token", "text", "gen_random_uuid()::text"),
              // Non-literal defaults are untouched and still match.
              probeColumn("created_at", "timestamptz", "now()"),
              probeColumn("enabled", "boolean", "false"),
              probeColumn("attempts", "integer", "0"),
            ],
          };

          const diff = await diffManifestAgainstDatabase(db, [table]);
          expect(diff.nonAdditive).toEqual([]);
          expect(diff.missingTables).toEqual([]);
          expect(diff.missingColumns).toEqual([]);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a genuinely changed default expression is still non-additive drift",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          await sql`create schema drift_probe`.execute(db);
          await sql`
            create table drift_probe.changed_defaults (
              changed_literal text not null default 'draft',
              wrapped_call text not null default upper('process'),
              foreign_cast text not null default 'process'::varchar,
              concatenated text not null default 'a' || '',
              shifted_clock timestamptz not null default now() - interval '1 day',
              changed_json jsonb not null default '{"version":2,"branches":[]}',
              precise_json jsonb not null default '{"amount":9007199254740993}',
              precise_decimal jsonb not null default '{"amount":1.0000000000000001}',
              tiny_exponent jsonb not null default '{"amount":1e-999}',
              unchanged text not null default 'process'
            )
          `.execute(db);

          const table: ManifestTable = {
            name: "drift_probe.changed_defaults",
            schema: "drift_probe",
            table: "changed_defaults",
            columns: [
              probeColumn("changed_literal", "text", "'process'"),
              probeColumn("wrapped_call", "text", "'process'"),
              // The cast must name the column's OWN type to be redundant;
              // ::varchar on a text column is a different expression.
              probeColumn("foreign_cast", "text", "'process'"),
              probeColumn("concatenated", "text", "'a'"),
              probeColumn("shifted_clock", "timestamptz", "now()"),
              probeColumn("changed_json", "jsonb", '\'{"branches":[],"version":1}\'::jsonb'),
              // Distinct jsonb numerics outside JavaScript's safe integer
              // range must never collapse to equality during normalization.
              probeColumn("precise_json", "jsonb", "'{\"amount\":9007199254740992}'::jsonb"),
              // JSON.parse rounds both of these live values to the manifest
              // value; their original number tokens must remain distinct.
              probeColumn("precise_decimal", "jsonb", "'{\"amount\":1}'::jsonb"),
              probeColumn("tiny_exponent", "jsonb", "'{\"amount\":0}'::jsonb"),
              // Control: proves the five above are not drifting for some
              // unrelated reason.
              probeColumn("unchanged", "text", "'process'"),
            ],
          };

          const diff = await diffManifestAgainstDatabase(db, [table]);
          const drifted = diff.nonAdditive;
          expect(drifted).toHaveLength(9);
          for (const column of [
            "changed_literal",
            "wrapped_call",
            "foreign_cast",
            "concatenated",
            "shifted_clock",
            "changed_json",
            "precise_json",
            "precise_decimal",
            "tiny_exponent",
          ]) {
            expect(
              drifted.some((line) =>
                line.startsWith(`drift_probe.changed_defaults.${column}: default mismatch`),
              ),
            ).toBe(true);
          }
          expect(drifted.some((line) => line.includes("unchanged"))).toBe(false);

          // The report quotes both sides verbatim; normalization is for the
          // comparison only, so a reader still sees what the database holds.
          const foreignCast = drifted.find((line) => line.includes("foreign_cast"));
          expect(foreignCast).toContain("DEFAULT 'process'");
          expect(foreignCast).toContain("'process'::character varying");
        });
      });
    },
    TEST_TIMEOUT,
  );
});

describe("plugin-migration-owned columns", () => {
  // The osf-integration plugin's 0004_platform-catalog migration ALTERs the
  // generated integration.* tables to add its installation bookkeeping. Those
  // columns exist in the database and not in the manifest by design, so the
  // roll-forward diff must not classify them as non-additive drift — while a
  // column nobody declared anywhere stays drift.
  const idColumn = probeColumn("id", "uuid", "gen_random_uuid()", {
    primaryKey: true,
  });

  test(
    "a column owned by a plugin schema migration is not drift",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          await sql`create schema integration`.execute(db);
          await sql`
            create table integration.adapters (
              id uuid primary key default gen_random_uuid(),
              key text not null default '',
              catalog_entry_id uuid,
              installed_version integer,
              overridden boolean not null default false,
              override_fields text[] not null default '{}',
              update_available_version integer
            )
          `.execute(db);

          const table: ManifestTable = {
            name: "integration.adapters",
            schema: "integration",
            table: "adapters",
            columns: [idColumn, probeColumn("key", "text", "''")],
          };

          const diff = await diffManifestAgainstDatabase(db, [table]);
          expect(diff.nonAdditive).toEqual([]);
          expect(diff.missingTables).toEqual([]);
          expect(diff.missingColumns).toEqual([]);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a column no plugin migration owns is still non-additive drift",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          await sql`create schema integration`.execute(db);
          // The exempt table plus one column with no owner at all, and a
          // second table where the plugin-owned NAME is not exempt: the
          // exemption is keyed schema.table.column, not just column.
          await sql`
            create table integration.adapters (
              id uuid primary key default gen_random_uuid(),
              catalog_entry_id uuid,
              rogue text
            )
          `.execute(db);
          await sql`
            create table integration.unrelated (
              id uuid primary key default gen_random_uuid(),
              catalog_entry_id uuid
            )
          `.execute(db);

          const diff = await diffManifestAgainstDatabase(db, [
            {
              name: "integration.adapters",
              schema: "integration",
              table: "adapters",
              columns: [idColumn],
            },
            {
              name: "integration.unrelated",
              schema: "integration",
              table: "unrelated",
              columns: [idColumn],
            },
          ]);
          expect(diff.nonAdditive).toEqual([
            "integration.adapters.rogue: column exists in the database but not in the generated manifest",
            "integration.unrelated.catalog_entry_id: column exists in the database but not in the generated manifest",
          ]);
        });
      });
    },
    TEST_TIMEOUT,
  );
});
