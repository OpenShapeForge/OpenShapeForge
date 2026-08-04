// SPDX-License-Identifier: BUSL-1.1
/**
 * Migration-evolution tests. Every scenario runs the real migration chain
 * (app helpers -> system bypass audit -> versioned -> generated roll-forward)
 * against a throwaway SCRATCH database created and dropped through the admin
 * URL on the same Postgres instance. The live openshapeforge_dev database is
 * never touched.
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
import { sql, type Kysely } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { generatedSchemaMigrationVersion } from "../migrations/generated-schema.js";
import {
  applyVersionedMigrations,
  validateVersionedRegistry,
  type VersionedMigration,
} from "../migrations/versioned-runner.js";

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

async function withDb<T>(
  url: string,
  fn: (db: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

/** Runs the full migration chain the way migrate.ts does: connection-bound. */
async function runChain(url: string, versioned?: VersionedMigration[]) {
  return withDb(url, (db) =>
    db
      .connection()
      .execute((conn) =>
        runMigrationChain(conn, versioned === undefined ? {} : { versioned }),
      ),
  );
}

async function runVersioned(url: string, registry: VersionedMigration[]) {
  return withDb(url, (db) =>
    db.connection().execute((conn) => applyVersionedMigrations(conn, registry)),
  );
}

async function tableExists(
  db: Kysely<DB>,
  schema: string,
  table: string,
): Promise<boolean> {
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

async function recordedChecksum(
  db: Kysely<DB>,
  version: string,
): Promise<string | null> {
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
        // Phase 2 ships the org-unit closure trigger as a versioned migration,
        // 0003 hardens it against a cross-tenant/nonexistent parent_id and 0004
        // hardens its reparent branch with a cycle guard, so a fresh install
        // applies all three in order. The list mirrors the registry in
        // migrations/versioned/index.ts.
        expect(first.versionedApplied).toEqual([
          "0002_org-unit-closure-trigger",
          "0003_org-unit-parent-tenant-guard",
          "0004_org-unit-reparent-cycle-guard",
        ]);

        await withDb(url, async (db) => {
          expect(
            await recordedChecksum(db, generatedSchemaMigrationVersion),
          ).toBe(manifest.checksum);
          expect(await tableExists(db, "erp", "relations")).toBe(true);
          expect(await tableExists(db, "platform", "org_unit")).toBe(true);
          expect(await tableExists(db, "platform", "org_unit_closure")).toBe(true);
          expect(await tableExists(db, "platform", "retention_actions")).toBe(true);
          expect(await tableExists(db, "platform", "retention_review_queue")).toBe(true);
          expect(await tableExists(db, "platform", "retention_archive")).toBe(true);
          expect(await tableExists(db, "platform", "retention_crypto_delete_queue")).toBe(true);
        });

        const second = await runChain(url);
        expect(second.applied).toBe(false);
        expect(second.checksum).toBe(manifest.checksum);
        // On rerun the applied versioned migration is skipped, not reapplied.
        expect(second.versionedApplied).toEqual([]);
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
        expect(result.rollForward?.addedTables).toEqual([
          "platform.entity_field_suggestions",
        ]);
        expect(result.rollForward?.addedColumns).toEqual([
          "erp.relations.notes",
        ]);

        await withDb(url, async (db) => {
          expect(
            await tableExists(db, "platform", "entity_field_suggestions"),
          ).toBe(true);
          expect(await columnExists(db, "erp", "relations", "notes")).toBe(
            true,
          );
          expect(
            await recordedChecksum(db, generatedSchemaMigrationVersion),
          ).toBe(manifest.checksum);
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
          await sql`alter table erp.relations add column legacy_extra text`.execute(
            db,
          );
          await sql`
            update platform.schema_migrations
            set checksum = ${"simulated-old"}
            where version = ${generatedSchemaMigrationVersion}
          `.execute(db);
        });

        const message = await expectRejects(runChain(url));
        expect(message).toContain("erp.relations");
        expect(message).toContain("legacy_extra");
        expect(message).toContain("db:migration:new");

        // The failed run must not roll the checksum forward.
        await withDb(url, async (db) => {
          expect(
            await recordedChecksum(db, generatedSchemaMigrationVersion),
          ).toBe("simulated-old");
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
          await sql`alter table erp.relations drop column display_name`.execute(
            db,
          );
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
        expect(result.rollForward?.addedColumns).toEqual([
          "erp.relations.display_name",
        ]);
        await withDb(url, async (db) => {
          expect(
            await columnExists(db, "erp", "relations", "display_name"),
          ).toBe(true);
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
        expect(message).toContain("db:migration:new");

        // The failed run must not roll the checksum forward.
        await withDb(url, async (db) => {
          expect(
            await recordedChecksum(db, generatedSchemaMigrationVersion),
          ).toBe("simulated-old");
        });
      });
    },
    TEST_TIMEOUT,
  );
});

describe("versioned migrations framework", () => {
  test(
    "applies, records file checksum, skips on rerun, and rejects edited applied files",
    async () => {
      await withScratchDb(async (url) => {
        await runChain(url); // baseline first, like a real deployment

        const dir = await mkdtemp(join(tmpdir(), "openshapeforge-versioned-"));
        const file = join(dir, "0002_create-bespoke-things.ts");
        await writeFile(file, "// test migration file v1\n");

        let upCalls = 0;
        const registry: VersionedMigration[] = [
          {
            version: "0002_create-bespoke-things",
            fileUrl: pathToFileURL(file).href,
            up: async (db) => {
              upCalls += 1;
              await sql`create schema if not exists bespoke`.execute(db);
              await sql`create table bespoke.things (id text primary key)`.execute(
                db,
              );
            },
          },
        ];

        const first = await runVersioned(url, registry);
        expect(first.applied).toEqual(["0002_create-bespoke-things"]);
        expect(first.skipped).toEqual([]);
        expect(upCalls).toBe(1);

        const expectedChecksum = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
        await withDb(url, async (db) => {
          expect(
            await recordedChecksum(db, "0002_create-bespoke-things"),
          ).toBe(expectedChecksum);
          expect(await tableExists(db, "bespoke", "things")).toBe(true);
        });

        const second = await runVersioned(url, registry);
        expect(second.applied).toEqual([]);
        expect(second.skipped).toEqual(["0002_create-bespoke-things"]);
        expect(upCalls).toBe(1);

        // Simulate editing an applied migration file: loud error.
        await appendFile(file, "// edited after apply\n");
        const message = await expectRejects(runVersioned(url, registry));
        expect(message).toContain("0002_create-bespoke-things");
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

        const dir = await mkdtemp(join(tmpdir(), "openshapeforge-versioned-"));
        const file = join(dir, "0002_inert-edit.ts");
        await writeFile(file, "// migration file v1\n");
        const originalChecksum = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");

        let upCalls = 0;
        const up: VersionedMigration["up"] = async (db) => {
          upCalls += 1;
          await sql`create schema if not exists bespoke`.execute(db);
          await sql`create table bespoke.inert (id text primary key)`.execute(db);
        };

        const before: VersionedMigration[] = [
          { version: "0002_inert-edit", fileUrl: pathToFileURL(file).href, up },
        ];
        expect((await runVersioned(url, before)).applied).toEqual(["0002_inert-edit"]);
        expect(upCalls).toBe(1);

        // The edit this exists for: a comment, changing the hash and nothing else.
        await appendFile(file, "// SPDX-License-Identifier: BUSL-1.1\n");
        const editedChecksum = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
        expect(editedChecksum).not.toBe(originalChecksum);

        // Without a declaration this is still an immutability violation.
        const refused = await expectRejects(runVersioned(url, before));
        expect(refused).toContain("immutable");
        expect(refused).toContain("supersededChecksums");

        const after: VersionedMigration[] = [
          {
            version: "0002_inert-edit",
            fileUrl: pathToFileURL(file).href,
            up,
            supersededChecksums: [originalChecksum],
          },
        ];

        const reconciled = await runVersioned(url, after);
        expect(reconciled.reconciled).toEqual(["0002_inert-edit"]);
        expect(reconciled.applied).toEqual([]);
        expect(reconciled.skipped).toEqual([]);
        // Reconciling must not re-run DDL the ledger already claims happened.
        expect(upCalls).toBe(1);

        await withDb(url, async (db) => {
          expect(await recordedChecksum(db, "0002_inert-edit")).toBe(editedChecksum);
        });

        // Once reconciled the entry is inert: the plain skip path takes over.
        const settled = await runVersioned(url, after);
        expect(settled.reconciled).toEqual([]);
        expect(settled.skipped).toEqual(["0002_inert-edit"]);
        expect(upCalls).toBe(1);

        // A hash nobody declared still fails, declaration list or not.
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

        const dir = await mkdtemp(join(tmpdir(), "openshapeforge-versioned-"));
        const file = join(dir, "0002_boom.ts");
        await writeFile(file, "// failing migration file\n");

        const registry: VersionedMigration[] = [
          {
            version: "0002_boom",
            fileUrl: pathToFileURL(file).href,
            up: async (db) => {
              await sql`create schema if not exists bespoke`.execute(db);
              await sql`create table bespoke.partial (id text primary key)`.execute(
                db,
              );
              throw new Error("intentional failure");
            },
          },
        ];

        const message = await expectRejects(runVersioned(url, registry));
        expect(message).toContain("0002_boom");
        expect(message).toContain("rolled back");

        await withDb(url, async (db) => {
          expect(await tableExists(db, "bespoke", "partial")).toBe(false);
          expect(await recordedChecksum(db, "0002_boom")).toBeNull();
        });
      });
    },
    TEST_TIMEOUT,
  );

  test("registry validation rejects bad versions without touching the database", () => {
    const up = async () => {};
    const entry = (version: string): VersionedMigration => ({
      version,
      fileUrl: import.meta.url,
      up,
    });

    expect(() => validateVersionedRegistry([entry("0002_ok")])).not.toThrow();
    expect(() =>
      validateVersionedRegistry([entry("0002_ok"), entry("0003_also-ok")]),
    ).not.toThrow();
    expect(() => validateVersionedRegistry([entry("2_bad")])).toThrow(
      "invalid version",
    );
    expect(() => validateVersionedRegistry([entry("0002_Bad_Name")])).toThrow(
      "invalid version",
    );
    expect(() => validateVersionedRegistry([entry("0001_taken")])).toThrow(
      "reserved",
    );
    expect(() =>
      validateVersionedRegistry([entry("0003_late"), entry("0002_early")]),
    ).toThrow("strictly after");
    expect(() =>
      validateVersionedRegistry([entry("0002_dup"), entry("0002_dup-again")]),
    ).toThrow("strictly after");
  });
});
