// SPDX-License-Identifier: BUSL-1.1
/**
 * Seeding of the workflow plugin's three catalog tables, against a throwaway
 * SCRATCH database created and dropped through the admin URL. The live
 * openshapeforge_dev database is never touched.
 *
 * The load-bearing case is the shared table: `node-catalog.seed.json` and
 * `entity-catalog.seed.json` both write to
 * `platform.workflow_node_catalog_entries` under different `catalog` values, so
 * each must be authoritative over its own slice and blind to the other's.
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
import { applyWorkflowCatalogsSeed } from "../migrations/workflow-catalogs-seed.js";

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
  const name = `wfcatalog_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

/**
 * Migrate, then apply the workflow seeds directly.
 *
 * The seeds reach the chain through the runtime module contract now
 * (`examples/plugins/workflow/runtime.ts`), which reports one combined result
 * per module. That is the right shape for an operator reading migrate output
 * and the wrong shape for asserting per-slice behaviour, so the wiring is
 * covered by its own test in module-seeds.test.ts and this file drives the
 * seed itself.
 */
async function runChain(url: string) {
  return withDb(url, async (db) => {
    await db.connection().execute((conn) => runMigrationChain(conn));
    return db.connection().execute((conn) => applyWorkflowCatalogsSeed(conn));
  });
}

async function countByCatalog(db: Kysely<DB>, catalog: string): Promise<number> {
  const row = await db
    .selectFrom("platform.workflow_node_catalog_entries")
    .where("catalog", "=", catalog)
    .select(({ fn }) => fn.countAll<string>().as("total"))
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

describe("workflow catalog seeds", () => {
  test(
    "seeds all three catalogs, stores jsonb as objects, and is idempotent",
    async () => {
      await withScratchDb(async (url) => {
        const first = await runChain(url);
        const { nodeCatalogs, triggerRegistry, fieldSuggestions } = first;

        // Without the workflow plugin registered there are no seed documents;
        // an empty catalog is then correct and the rest does not apply.
        if (!nodeCatalogs.present) {
          expect(nodeCatalogs.rows).toBe(0);
          return;
        }

        expect(nodeCatalogs.skipped).toBe(false);
        expect(nodeCatalogs.rows).toBeGreaterThan(0);

        await withDb(url, async (db) => {
          // Both slices landed, and the combined result covers both.
          const standard = await countByCatalog(db, "standard");
          const entity = await countByCatalog(db, "entity");
          expect(standard).toBeGreaterThan(0);
          expect(entity).toBeGreaterThan(0);
          expect(standard + entity).toBe(nodeCatalogs.rows);

          // One checksum per slice — that is what makes the skip decision sound.
          for (const catalog of ["standard", "entity"]) {
            const checksums = await db
              .selectFrom("platform.workflow_node_catalog_entries")
              .where("catalog", "=", catalog)
              .select("catalog_checksum")
              .distinct()
              .execute();
            expect(checksums.length).toBe(1);
          }

          // Regression: jsonb columns must hold OBJECTS/ARRAYS, not jsonb
          // strings containing JSON — the failure mode of binding a
          // pre-stringified value.
          const kinds = await sql<{ label: string; config: string }>`
            select distinct jsonb_typeof(label) as label,
                            jsonb_typeof(config_fields) as config
            from platform.workflow_node_catalog_entries
          `.execute(db);
          expect(kinds.rows.map((row) => row.label)).toEqual(["object"]);
          expect(kinds.rows.map((row) => row.config)).toEqual(["array"]);

          if (triggerRegistry.present) {
            const triggers = await db
              .selectFrom("platform.entity_trigger_registry")
              .select(["id", "module", "entity_type"])
              .execute();
            expect(triggers.length).toBe(triggerRegistry.rows);
            for (const row of triggers) {
              expect(row.id).toBe(`${row.module}:${row.entity_type}`);
            }
          }

          if (fieldSuggestions.present) {
            const suggestions = await db
              .selectFrom("platform.entity_field_suggestions")
              .select(["id", "entity"])
              .execute();
            expect(suggestions.length).toBe(fieldSuggestions.rows);
            for (const row of suggestions) {
              expect(row.id).toBe(row.entity);
            }
          }
        });

        // Unchanged input: the second run must rewrite nothing.
        const second = await runChain(url);
        expect(second.nodeCatalogs.skipped).toBe(true);
        expect(second.nodeCatalogs.rows).toBe(nodeCatalogs.rows);
        expect(second.triggerRegistry.skipped).toBe(true);
        expect(second.fieldSuggestions.skipped).toBe(true);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "each catalog is authoritative over its own slice, and only its own",
    async () => {
      await withScratchDb(async (url) => {
        const first = await runChain(url);
        if (!first.nodeCatalogs.present) return;

        const entityBefore = await withDb(url, (db) => countByCatalog(db, "entity"));

        await withDb(url, async (db) => {
          // A stale row in the standard slice, with a checksum that is not the
          // seed's — so the next run cannot skip and must delete it.
          await db
            .insertInto("platform.workflow_node_catalog_entries")
            .values({
              node_type: "ghost.node",
              catalog: "standard",
              action: null,
              category: { en: "Ghost" } as never,
              label: {} as never,
              description: null,
              config_fields: [] as never,
              output_fields: [] as never,
              default_config: {} as never,
              catalog_checksum: "stale",
            })
            .execute();
        });

        const second = await runChain(url);
        expect(second.nodeCatalogs.skipped).toBe(false);

        await withDb(url, async (db) => {
          const ghost = await db
            .selectFrom("platform.workflow_node_catalog_entries")
            .select("node_type")
            .where("node_type", "=", "ghost.node")
            .executeTakeFirst();
          expect(ghost).toBeUndefined();

          // The entity slice was never in scope of the standard seed's delete.
          expect(await countByCatalog(db, "entity")).toBe(entityBefore);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a stale trigger-registry row is removed",
    async () => {
      await withScratchDb(async (url) => {
        const first = await runChain(url);
        if (!first.triggerRegistry.present) return;

        await withDb(url, async (db) => {
          await db
            .insertInto("platform.entity_trigger_registry")
            .values({
              id: "ghost:ghosts",
              module: "ghost",
              entity: "Ghost",
              entity_type: "ghosts",
              domains: [] as never,
              label: {} as never,
              filter_fields: [] as never,
              checksum: "stale",
            })
            .execute();
        });

        const second = await runChain(url);
        expect(second.triggerRegistry.skipped).toBe(false);

        await withDb(url, async (db) => {
          const ghost = await db
            .selectFrom("platform.entity_trigger_registry")
            .select("id")
            .where("id", "=", "ghost:ghosts")
            .executeTakeFirst();
          expect(ghost).toBeUndefined();
        });
      });
    },
    TEST_TIMEOUT,
  );
});
