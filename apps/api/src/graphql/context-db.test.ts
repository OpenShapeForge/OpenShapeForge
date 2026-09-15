// SPDX-License-Identifier: BUSL-1.1
/** Database-backed half of the GraphQL scope propagation regression test. */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../generated/db/types.js";
import { createDatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { withDbSession } from "../db/session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;

function scratchAdminUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `context_scope_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

async function readScopeState<TDatabase>(trx: import("kysely").Transaction<TDatabase>) {
  const scopeRow = await sql<{ scope: string }>`
    select current_setting('app.scope') as scope
  `.execute(trx);
  const hasRow = await sql<{ has: boolean }>`
    select app.has_scope('tenant') as has
  `.execute(trx);
  return { scope: scopeRow.rows[0]?.scope, has: hasRow.rows[0]?.has };
}

describe("withDbSession applies app.scope (F5)", () => {
  test(
    "scope=tenant sets app.scope and app.has_scope('tenant')=true; missing scope defaults to self",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), (db) =>
          db.connection().execute((conn) => runMigrationChain(conn)),
        );

        await withDb(scratchAdminUrl(name), async (db) => {
          const tenantId = randomUUID();
          const userId = randomUUID();
          const tenantResult = await withDbSession(
            db,
            { tenantId, userId, roles: [], groups: [], scope: "tenant" },
            (trx) => readScopeState(trx),
          );
          expect(tenantResult.scope).toBe("tenant");
          expect(tenantResult.has).toBe(true);

          const defaultResult = await withDbSession(
            db,
            { tenantId, userId, roles: [], groups: [] },
            (trx) => readScopeState(trx),
          );
          expect(defaultResult.scope).toBe("self");
          expect(defaultResult.has).toBe(false);
        });
      });
    },
    TEST_TIMEOUT,
  );
});
