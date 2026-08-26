// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { versionedMigrations } from "../migrations/versioned/index.js";
import { verifyVersionedMigrationLedger } from "../migrations/versioned-runner.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const databaseName = `versioned_readiness_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databaseUrl = new URL(ADMIN_URL);
databaseUrl.pathname = `/${databaseName}`;
const admin = new SQL(ADMIN_URL, { max: 1 });

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(databaseName) || new URL(ADMIN_URL).pathname === "/openshapeforge_dev") {
    throw new Error("Refusing an unsafe readiness scratch database target.");
  }
  await admin.unsafe(`create database "${databaseName}"`);
});

afterAll(async () => {
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin.close();
});

describe("versioned migration readiness", () => {
  test("detects missing and checksum-drifted entries in the complete registry", async () => {
    const runtime = createDatabaseRuntime({ databaseUrl: databaseUrl.toString() });
    try {
      await runtime.db.connection().execute((db) => runMigrationChain(db));
      expect(await verifyVersionedMigrationLedger(runtime.db, versionedMigrations))
        .toEqual({ ready: true, missing: [], mismatched: [] });

      const missing = versionedMigrations[0]!.version;
      const mismatched = versionedMigrations[1]!.version;
      await sql`delete from platform.schema_migrations where version = ${missing}`
        .execute(runtime.db);
      await sql`
        update platform.schema_migrations set checksum = ${"stale-readiness"}
        where version = ${mismatched}
      `.execute(runtime.db);

      expect(await verifyVersionedMigrationLedger(runtime.db, versionedMigrations))
        .toEqual({ ready: false, missing: [missing], mismatched: [mismatched] });
    } finally {
      await runtime.close();
    }
  }, 90_000);
});
