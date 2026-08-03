// SPDX-License-Identifier: BUSL-1.1
/**
 * Seeds reaching the migration chain through the runtime module contract.
 *
 * The seed logic itself is covered by workflow-catalogs-seed.test.ts; what this
 * proves is the wiring — that a module registered by the compiler is resolved
 * at boot, that its seed runs as part of the chain, and that a chain run with
 * no modules seeds nothing. Without the last one the contract would be
 * indistinguishable from the hardcoded call it replaced.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import type { Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

async function withScratchDb<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const name = `modseed_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      const url = new URL(ADMIN_URL);
      if (url.pathname === "/openshapeforge_dev") {
        throw new Error("admin URL must not point at openshapeforge_dev");
      }
      url.pathname = `/${name}`;
      return await fn(url.toString());
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

describe("module-contributed seeds", () => {
  test(
    "a registered module's seed runs as part of the chain",
    async () => {
      const modules = await loadRuntimeModules();
      expect(modules.failures).toEqual([]);

      const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
      // Two plugins contribute a seed each: the workflow plugin's standard and
      // entity catalogs, and the domain node packs split out of it. Order
      // follows `authoring.config.yaml`, and the chain applies them in it.
      expect(moduleSeeds.map((seed) => seed.name)).toEqual([
        "workflowCatalogs",
        "workflowDomainNodeCatalog",
      ]);

      await withScratchDb(async (url) => {
        const result = await withDb(url, (db) =>
          db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds })),
        );

        for (const name of ["workflowCatalogs", "workflowDomainNodeCatalog"]) {
          const seed = result.moduleSeeds[name];
          expect(seed).toBeDefined();
          expect(seed?.present).toBe(true);
          expect(seed?.skipped).toBe(false);
          expect(seed?.rows).toBeGreaterThan(0);
        }

        await withDb(url, async (db) => {
          // Both seeds write `platform.workflow_node_catalog_entries`, each
          // authoritative over its own `catalog` slice via a scoped delete. The
          // count per slice is what proves they coexist: a seed whose delete
          // was not scoped would leave its own rows and nothing else, and a
          // total-only assertion cannot tell that apart from a healthy table.
          const bySlice = await db
            .selectFrom("platform.workflow_node_catalog_entries")
            .select(({ fn }) => ["catalog", fn.countAll<string>().as("total")])
            .groupBy("catalog")
            .orderBy("catalog")
            .execute();

          expect(
            bySlice.map((row) => [row.catalog, Number(row.total) > 0]),
          ).toEqual([
            ["domain", true],
            ["entity", true],
            ["standard", true],
          ]);
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a chain run with no modules seeds nothing",
    async () => {
      await withScratchDb(async (url) => {
        const result = await withDb(url, (db) =>
          db.connection().execute((conn) => runMigrationChain(conn)),
        );
        expect(result.moduleSeeds).toEqual({});

        await withDb(url, async (db) => {
          const counted = await db
            .selectFrom("platform.workflow_node_catalog_entries")
            .select(({ fn }) => fn.countAll<string>().as("total"))
            .executeTakeFirst();
          // The table exists — the plugin contributes it at compile time — and
          // stays empty, which is the whole distinction between the two halves.
          expect(Number(counted?.total ?? 0)).toBe(0);
        });
      });
    },
    TEST_TIMEOUT,
  );
});
