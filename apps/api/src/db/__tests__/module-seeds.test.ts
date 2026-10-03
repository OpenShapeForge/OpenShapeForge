// SPDX-License-Identifier: BUSL-1.1
/**
 * Seeds reaching the migration chain through the runtime module contract.
 *
 * What this proves is the wiring — that a module seed handed to the chain
 * runs after the core seeds, in registration order, with the chain's
 * services, and that a chain run with no modules seeds nothing. Without the
 * last one the contract would be indistinguishable from a hardcoded call.
 * This repository composes no plugin that ships a seed, so the seed here is
 * synthetic: what a host's plugin would contribute.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import type { Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { ModuleSeed } from "../../modules/contract.js";
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
    "module seeds run as part of the chain, in order, with its services",
    async () => {
      const order: string[] = [];
      const seed = (name: string, rows: number): ModuleSeed => ({
        name,
        apply: async (db, services) => {
          order.push(name);
          expect(typeof services?.schemas.fields.object).toBe("function");
          // The chain's own seeds ran first: the seed sees a migrated schema.
          await db.selectFrom("platform.entity_page_configs").select("entity_slug").limit(1).execute();
          return { present: true, skipped: false, rows };
        },
      });
      const moduleSeeds = [seed("first", 3), seed("second", 1)];

      await withScratchDb(async (url) => {
        const result = await withDb(url, (db) =>
          db.connection().execute((conn) => runMigrationChain(conn, { moduleSeeds })),
        );
        expect(order).toEqual(["first", "second"]);
        expect(result.moduleSeeds).toEqual({
          first: { present: true, skipped: false, rows: 3 },
          second: { present: true, skipped: false, rows: 1 },
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
      });
    },
    TEST_TIMEOUT,
  );
});
