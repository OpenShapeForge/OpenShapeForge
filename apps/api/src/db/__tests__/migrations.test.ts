// SPDX-License-Identifier: BUSL-1.1
/**
 * Migration-chain tests. Every scenario runs the real chain (roles -> app
 * helpers -> generated schema -> core invariants -> grants -> seeds) against
 * a throwaway SCRATCH database created and dropped through the admin URL on
 * the same Postgres instance. The live openshapeforge_dev database is never
 * touched.
 *
 * Under test: an empty database is built, a built one with the bundled
 * checksum is left alone, and a built one with any other checksum is carried
 * forward — pending versioned migrations first, then the additive
 * roll-forward — or refused with the exact non-additive listing.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db 2>&1
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import {
  loadGeneratedPluginMigrations,
  parseCompilerConstraint,
} from "../migrations/generated-plugin-migrations.js";
import {
  applyVersionedMigrations,
  validateVersionedRegistry,
  type VersionedMigration,
} from "../migrations/versioned-runner.js";
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
async function runChain(url: string, versioned?: VersionedMigration[]) {
  return withDb(url, (db) =>
    db.connection().execute((conn) =>
      runMigrationChain(conn, versioned === undefined ? {} : { versioned }),
    ),
  );
}

async function runVersioned(url: string, registry: VersionedMigration[]) {
  return withDb(url, (db) =>
    db.connection().execute((conn) => applyVersionedMigrations(conn, registry)),
  );
}

/** Make the database look built from an older manifest. */
async function staleChecksum(db: Kysely<DB>): Promise<void> {
  await sql`
    update platform.schema_migrations
    set checksum = ${"simulated-old"}
    where version = ${generatedSchemaMigrationVersion}
  `.execute(db);
}

async function migrationFile(name: string, contents = "// test migration file v1\n") {
  const dir = await mkdtemp(join(tmpdir(), "openshapeforge-versioned-"));
  const file = join(dir, `${name}.ts`);
  await writeFile(file, contents);
  return file;
}

function fileChecksum(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
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
    "additive roll-forward recreates a dropped table and column and rolls the checksum forward",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        // An older database: one table and one nullable column are missing,
        // and the recorded checksum is another manifest's.
        await withDb(url, async (db) => {
          await sql`drop table erp.project_objectives`.execute(db);
          await sql`alter table erp.relations drop column notes`.execute(db);
          await staleChecksum(db);
        });

        const result = await runChain(url);
        expect(result.applied).toBe(true);
        expect(result.built).toBeUndefined();
        expect(result.checksum).toBe(manifest.checksum);
        expect(result.rollForward).toEqual({
          addedTables: ["erp.project_objectives"],
          addedColumns: ["erp.relations.notes"],
        });

        await withDb(url, async (db) => {
          expect(await tableExists(db, "erp", "project_objectives")).toBe(true);
          expect(await columnExists(db, "erp", "relations", "notes")).toBe(true);
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe(
            manifest.checksum,
          );
          // The re-created table is exactly what a fresh build declares.
          expect(await findUndeclaredDatabaseSchema(db)).toEqual({ tables: [], columns: [] });
        });

        expect((await runChain(url)).applied).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a column the manifest does not declare blocks the roll-forward and records nothing",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        await withDb(url, async (db) => {
          await sql`alter table erp.relations add column legacy_extra text`.execute(db);
          await staleChecksum(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("non-additive drift");
        expect(message).toContain(
          "erp.relations.legacy_extra: column exists in the database but not in the generated manifest",
        );
        expect(message).toContain("bun run db:migration:new");
        expect(message).toContain("bun run db:reset");

        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe(
            "simulated-old",
          );
          expect(await columnExists(db, "erp", "relations", "legacy_extra")).toBe(true);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a required column with no default is non-additive on a populated table, additive on an empty one",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        await withDb(url, async (db) => {
          await sql`
            insert into erp.relations (tenant_id, display_name, relation_type)
            values (gen_random_uuid(), ${"Populated"}, ${"person"})
          `.execute(db);
          await sql`alter table erp.relations drop column display_name`.execute(db);
          await staleChecksum(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("erp.relations.display_name");
        expect(message).toContain("backfill");

        await withDb(url, async (db) => {
          await sql`delete from erp.relations`.execute(db);
        });
        const result = await runChain(url);
        expect(result.rollForward?.addedColumns).toEqual(["erp.relations.display_name"]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a required column with a default is added to a populated table",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        await withDb(url, async (db) => {
          await sql`
            insert into erp.relations (tenant_id, display_name, relation_type)
            values (gen_random_uuid(), ${"Populated"}, ${"person"})
          `.execute(db);
          await sql`alter table erp.relations drop column created_at`.execute(db);
          await staleChecksum(db);
        });

        const result = await runChain(url);
        expect(result.rollForward?.addedColumns).toEqual(["erp.relations.created_at"]);
        await withDb(url, async (db) => {
          const rows = await sql<{ filled: boolean }>`
            select created_at is not null as filled from erp.relations
          `.execute(db);
          expect(rows.rows).toEqual([{ filled: true }]);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a changed column default is non-additive drift",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        await withDb(url, async (db) => {
          await sql`
            alter table erp.relations alter column created_at set default now() - interval '1 day'
          `.execute(db);
          await staleChecksum(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("erp.relations.created_at: default mismatch");
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, generatedSchemaMigrationVersion)).toBe(
            "simulated-old",
          );
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a versioned migration settles a rename the roll-forward refuses, keeping the rows",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        // An older database where the manifest's `notes` was still `remarks`.
        await withDb(url, async (db) => {
          await sql`alter table erp.relations rename column notes to remarks`.execute(db);
          await sql`
            insert into erp.relations (tenant_id, display_name, relation_type, remarks)
            values (gen_random_uuid(), ${"Kept"}, ${"person"}, ${"carried over"})
          `.execute(db);
          await staleChecksum(db);
        });

        // Without the migration the rename reads as a dropped and an added
        // column, and the dropped one is refused.
        const refused = await expectRejects(runChain(url));
        expect(refused).toContain("erp.relations.remarks: column exists in the database");

        const file = await migrationFile("0016_rename-relation-remarks");
        const registry: VersionedMigration[] = [
          {
            version: "0016_rename-relation-remarks",
            fileUrl: pathToFileURL(file).href,
            up: async (db) => {
              await sql`alter table erp.relations rename column remarks to notes`.execute(db);
            },
          },
        ];
        const result = await runChain(url, registry);
        expect(result.versioned.applied).toEqual(["0016_rename-relation-remarks"]);
        expect(result.rollForward).toEqual({ addedTables: [], addedColumns: [] });
        expect(result.checksum).toBe(manifest.checksum);

        await withDb(url, async (db) => {
          const rows = await sql<{ notes: string }>`
            select notes from erp.relations where display_name = ${"Kept"}
          `.execute(db);
          expect(rows.rows).toEqual([{ notes: "carried over" }]);
          expect(await recordedChecksum(db, "0016_rename-relation-remarks")).toBe(
            fileChecksum(await readFile(file)),
          );
        });

        const again = await runChain(url, registry);
        expect(again.versioned).toEqual({
          applied: [],
          skipped: ["0016_rename-relation-remarks"],
          reconciled: [],
        });
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

/**
 * Column-default drift (issue #210). The bundled manifest cannot exhibit both
 * spellings of the same default at once, so these tests drive the classifier
 * against a purpose-built schema instead. The DDL below is written the way the
 * generated schema.sql renders each authoring spelling, so what is compared
 * is a real live column, not a string.
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
          await sql`create schema drift_probe`.execute(db);
          await sql`
            create table drift_probe.equivalent_defaults (
              id uuid primary key default gen_random_uuid(),
              category text not null default 'process',
              quoted_label text not null default 'it''s',
              external_ref uuid not null default '00000000-0000-0000-0000-000000000001',
              payload jsonb not null default '{}',
              effective_on date not null default '2020-01-01',
              instance_key text not null default 'default',
              tags text[] not null default '{}',
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
              probeColumn("id", "uuid", "gen_random_uuid()", { primaryKey: true }),
              probeColumn("category", "text", "'process'"),
              probeColumn("quoted_label", "text", "'it''s'"),
              probeColumn("external_ref", "uuid", "'00000000-0000-0000-0000-000000000001'"),
              probeColumn("payload", "jsonb", "'{}'"),
              probeColumn("effective_on", "date", "'2020-01-01'"),
              // Authored WITH the cast, live column created bare.
              probeColumn("instance_key", "text", "'default'::text"),
              probeColumn("tags", "text[]", "'{}'::text[]"),
              probeColumn("created_at", "timestamptz", "now()"),
              probeColumn("enabled", "boolean", "false"),
              probeColumn("attempts", "integer", "0"),
            ],
          };

          expect(await diffManifestAgainstDatabase(db, [table])).toEqual({
            missingTables: [],
            missingColumns: [],
            nonAdditive: [],
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a genuinely changed default or type is still non-additive drift",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, async (db) => {
          await sql`create schema drift_probe`.execute(db);
          await sql`
            create table drift_probe.changed_defaults (
              changed_literal text not null default 'draft',
              foreign_cast text not null default 'process'::varchar,
              shifted_clock timestamptz not null default now() - interval '1 day',
              retyped integer[] not null default '{}',
              unchanged text not null default 'process'
            )
          `.execute(db);

          const table: ManifestTable = {
            name: "drift_probe.changed_defaults",
            schema: "drift_probe",
            table: "changed_defaults",
            columns: [
              probeColumn("changed_literal", "text", "'process'"),
              probeColumn("foreign_cast", "text", "'process'"),
              probeColumn("shifted_clock", "timestamptz", "now()"),
              probeColumn("retyped", "text[]", "'{}'::text[]"),
              probeColumn("unchanged", "text", "'process'"),
            ],
          };

          const { nonAdditive } = await diffManifestAgainstDatabase(db, [table]);
          expect(nonAdditive.map((line) => line.split(" — ")[0])).toEqual([
            "drift_probe.changed_defaults.changed_literal: default mismatch",
            "drift_probe.changed_defaults.foreign_cast: default mismatch",
            "drift_probe.changed_defaults.shifted_clock: default mismatch",
            "drift_probe.changed_defaults.retyped: type mismatch",
            "drift_probe.changed_defaults.retyped: default mismatch",
          ]);
          // Both sides are quoted verbatim; normalization is for comparing.
          expect(nonAdditive[1]).toContain("'process'::character varying");
        });
      });
    },
    TEST_TIMEOUT,
  );
});

describe("versioned migrations", () => {
  test(
    "a fresh build records the registry as its baseline without running it",
    async () => {
      await withScratchDb(async (url) => {
        const file = await migrationFile("0016_already-in-the-manifest");
        let upCalls = 0;
        const registry: VersionedMigration[] = [
          {
            version: "0016_already-in-the-manifest",
            fileUrl: pathToFileURL(file).href,
            up: async () => {
              upCalls += 1;
            },
          },
        ];

        const built = await runChain(url, registry);
        expect(built.built).toBe(true);
        expect(built.versioned.applied).toEqual([]);
        expect(upCalls).toBe(0);
        await withDb(url, async (db) => {
          const row = await sql<{ checksum: string; applied_by: string }>`
            select checksum, applied_by from platform.schema_migrations
            where version = ${"0016_already-in-the-manifest"}
          `.execute(db);
          expect(row.rows).toEqual([
            { checksum: fileChecksum(await readFile(file)), applied_by: "apps/api baseline" },
          ]);
        });

        expect((await runChain(url, registry)).versioned.skipped).toEqual([
          "0016_already-in-the-manifest",
        ]);
        expect(upCalls).toBe(0);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "applies, records the file checksum, skips on rerun, and rejects an edited applied file",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        const file = await migrationFile("0016_create-bespoke-things");
        let upCalls = 0;
        const registry: VersionedMigration[] = [
          {
            version: "0016_create-bespoke-things",
            fileUrl: pathToFileURL(file).href,
            up: async (db) => {
              upCalls += 1;
              await sql`create schema if not exists bespoke`.execute(db);
              await sql`create table bespoke.things (id text primary key)`.execute(db);
            },
          },
        ];

        expect((await runVersioned(url, registry)).applied).toEqual([
          "0016_create-bespoke-things",
        ]);
        expect(upCalls).toBe(1);
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, "0016_create-bespoke-things")).toBe(
            fileChecksum(await readFile(file)),
          );
          expect(await tableExists(db, "bespoke", "things")).toBe(true);
        });

        expect((await runVersioned(url, registry)).skipped).toEqual([
          "0016_create-bespoke-things",
        ]);
        expect(upCalls).toBe(1);

        await appendFile(file, "// edited after apply\n");
        const message = await expectRejects(runVersioned(url, registry));
        expect(message).toContain("0016_create-bespoke-things");
        expect(message).toContain("immutable");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "reconciles a superseded checksum once, without re-running the migration",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        const file = await migrationFile("0016_inert-edit", "// migration file v1\n");
        const originalChecksum = fileChecksum(await readFile(file));
        let upCalls = 0;
        const up: VersionedMigration["up"] = async () => {
          upCalls += 1;
        };
        const before: VersionedMigration[] = [
          { version: "0016_inert-edit", fileUrl: pathToFileURL(file).href, up },
        ];
        expect((await runVersioned(url, before)).applied).toEqual(["0016_inert-edit"]);

        await appendFile(file, "// SPDX-License-Identifier: BUSL-1.1\n");
        const editedChecksum = fileChecksum(await readFile(file));
        expect(await expectRejects(runVersioned(url, before))).toContain("supersededChecksums");

        const after: VersionedMigration[] = [
          { ...before[0]!, supersededChecksums: [originalChecksum] },
        ];
        expect(await runVersioned(url, after)).toEqual({
          applied: [],
          skipped: [],
          reconciled: ["0016_inert-edit"],
        });
        expect(upCalls).toBe(1);
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, "0016_inert-edit")).toBe(editedChecksum);
        });
        expect((await runVersioned(url, after)).skipped).toEqual(["0016_inert-edit"]);

        await appendFile(file, "// a second, undeclared edit\n");
        expect(await expectRejects(runVersioned(url, after))).toContain("immutable");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a failing migration is rolled back atomically and records nothing",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);

        const file = await migrationFile("0016_boom");
        const registry: VersionedMigration[] = [
          {
            version: "0016_boom",
            fileUrl: pathToFileURL(file).href,
            up: async (db) => {
              await sql`create schema if not exists bespoke`.execute(db);
              await sql`create table bespoke.partial (id text primary key)`.execute(db);
              throw new Error("intentional failure");
            },
          },
        ];

        const message = await expectRejects(runVersioned(url, registry));
        expect(message).toContain("0016_boom");
        expect(message).toContain("rolled back");
        await withDb(url, async (db) => {
          expect(await tableExists(db, "bespoke", "partial")).toBe(false);
          expect(await recordedChecksum(db, "0016_boom")).toBeNull();
        });
      });
    },
    TEST_TIMEOUT,
  );

  test("registry validation rejects bad and reserved versions without touching the database", () => {
    const entry = (version: string): VersionedMigration => ({
      version,
      fileUrl: import.meta.url,
      up: async () => {},
    });

    expect(() => validateVersionedRegistry([entry("0016_ok"), entry("0017_also-ok")])).not.toThrow();
    expect(() => validateVersionedRegistry([entry("16_bad")])).toThrow("invalid version");
    expect(() => validateVersionedRegistry([entry("0016_Bad_Name")])).toThrow("invalid version");
    // 0001 is the generated-schema record; 0002–0015 the retired chain.
    expect(() => validateVersionedRegistry([entry("0001_taken")])).toThrow("start at 0016");
    expect(() => validateVersionedRegistry([entry("0015_retired")])).toThrow("start at 0016");
    expect(() =>
      validateVersionedRegistry([entry("0017_late"), entry("0016_early")]),
    ).toThrow("strictly after");
    expect(() =>
      validateVersionedRegistry([entry("0016_dup"), entry("0016_dup-again")]),
    ).toThrow("strictly after");
  });
});

describe("compiler-rendered constraints on a carried-forward database", () => {
  test("every compiler-rendered registry entry is recognised", async () => {
    // The reconciliation below depends on recognising the renderer's exact
    // block; a renderer change that stops matching must fail here, not leave
    // stale checks in a deployed database.
    const migrations = await loadGeneratedPluginMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations.filter((entry) => entry.plugin === "osf-compiler")) {
      expect(parseCompilerConstraint(migration.sql)).toBeDefined();
    }
  });

  test(
    "a stale options check is replaced by definition, and a retired owned constraint is dropped",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url);
        await withDb(url, async (db) => {
          // An older manifest's narrower options list, under the same name.
          await sql`
            alter table erp.documents drop constraint documents_lifecycle_status_options_check
          `.execute(db);
          await sql`
            alter table erp.documents add constraint documents_lifecycle_status_options_check
              check (lifecycle_status in ('draft'))
          `.execute(db);
          // A check an older manifest rendered and this one no longer does.
          await sql`
            alter table erp.documents add constraint documents_retired_check check (true)
          `.execute(db);
          await sql`
            comment on constraint documents_retired_check on erp.documents
              is 'osf:plugin-constraint:osf-compiler'
          `.execute(db);
          await staleChecksum(db);
        });

        const result = await runChain(url);
        expect(result.pluginConstraintsRemoved).toEqual(["erp.documents.documents_retired_check"]);

        await withDb(url, async (db) => {
          const constraints = await sql<{ name: string; definition: string }>`
            select conname as name, pg_get_constraintdef(oid) as definition
            from pg_constraint
            where conrelid = 'erp.documents'::regclass
              and conname in ('documents_lifecycle_status_options_check', 'documents_retired_check')
          `.execute(db);
          expect(constraints.rows).toHaveLength(1);
          expect(constraints.rows[0]?.definition).toContain("'published'");
        });

        // Settled: nothing more to remove on the next run.
        expect((await runChain(url)).pluginConstraintsRemoved).toEqual([]);
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
