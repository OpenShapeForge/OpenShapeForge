// SPDX-License-Identifier: BUSL-1.1
/**
 * Seeding of platform.entity_page_configs, against a throwaway SCRATCH database
 * created and dropped through the admin URL. The live openshapeforge_dev
 * database is never touched.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";

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
  const name = `pageconfigs_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(scratchUrl(name));
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

async function runChain(url: string) {
  return withDb(url, (db) =>
    db.connection().execute((conn) => runMigrationChain(conn)),
  );
}

describe("platform.entity_page_configs seed", () => {
  test(
    "seeds the catalog, stores configs as jsonb objects, and is idempotent",
    async () => {
      await withScratchDb(async (url) => {
        const first = await runChain(url);

        // A repo without apps/web emits no seed; there is then nothing to
        // assert beyond the no-op, and the rest of this test does not apply.
        if (!first.pageConfigs.present) {
          expect(first.pageConfigs.rows).toBe(0);
          return;
        }

        expect(first.pageConfigs.skipped).toBe(false);
        expect(first.pageConfigs.rows).toBeGreaterThan(0);

        await withDb(url, async (db) => {
          const rows = await db
            .selectFrom("platform.entity_page_configs")
            .select(["id", "entity_slug", "config_kind", "checksum"])
            .execute();
          expect(rows.length).toBe(first.pageConfigs.rows);

          // id is the composite the seeder upserts on.
          for (const row of rows) {
            expect(row.id).toBe(`${row.entity_slug}:${row.config_kind}`);
          }
          // One checksum covers the whole catalog — that is what makes the
          // skip decision sound.
          expect(new Set(rows.map((row) => row.checksum)).size).toBe(1);

          // Regression: `configs` must be a jsonb OBJECT. Binding a
          // pre-stringified value stores a jsonb *string* containing JSON, and
          // every reader then gets a string back instead of the config.
          const types = await sql<{ kind: string | null }>`
            select distinct jsonb_typeof(configs) as kind
            from platform.entity_page_configs
          `.execute(db);
          expect(types.rows.map((row) => row.kind)).toEqual(["object"]);
        });

        // Unchanged input: the second run must not rewrite the catalog.
        const second = await runChain(url);
        expect(second.pageConfigs.skipped).toBe(true);
        expect(second.pageConfigs.rows).toBe(first.pageConfigs.rows);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "is authoritative — a row the seed no longer describes is removed",
    async () => {
      await withScratchDb(async (url) => {
        const first = await runChain(url);
        if (!first.pageConfigs.present) return;

        await withDb(url, async (db) => {
          await db
            .insertInto("platform.entity_page_configs")
            .values({
              id: "ghost-entity:list",
              entity_slug: "ghost-entity",
              config_kind: "list",
              configs: {} as never,
              // Not the seed checksum, so the next run cannot skip.
              checksum: "stale",
            })
            .execute();
        });

        const second = await runChain(url);
        expect(second.pageConfigs.skipped).toBe(false);

        await withDb(url, async (db) => {
          const ghost = await db
            .selectFrom("platform.entity_page_configs")
            .select("id")
            .where("id", "=", "ghost-entity:list")
            .executeTakeFirst();
          expect(ghost).toBeUndefined();
        });
      });
    },
    TEST_TIMEOUT,
  );
});
