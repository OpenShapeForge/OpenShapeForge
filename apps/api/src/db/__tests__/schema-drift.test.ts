/**
 * Unit tests for checkGeneratedSchemaDrift against a throwaway scratch
 * database. The scratch DB is created and dropped through the admin URL on
 * the same Postgres instance; the live openshapeforge_dev database is never
 * touched.
 *
 * The three tests walk one scratch database through the drift states in
 * order (bun runs tests in a file sequentially):
 *   1. empty database                     -> "unmigrated"
 *   2. migrations row with stale checksum -> "behind"
 *   3. row updated to bundled checksum    -> "ok"
 *
 * Run directly with:
 *   bun test src/db/__tests__/schema-drift.test.ts   (cwd: apps/api)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import {
  GENERATED_SCHEMA_MIGRATION_VERSION,
  checkGeneratedSchemaDrift,
} from "../schema-drift.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const scratchName = `schema_drift_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
if (!/^[a-z0-9_]+$/.test(scratchName)) {
  throw new Error(`unsafe scratch database name: ${scratchName}`);
}

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

let admin: SQL;
let runtime: DatabaseRuntime;

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  runtime = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 2 });
});

afterAll(async () => {
  await runtime?.close();
  // FORCE (Postgres 13+) kills any straggling scratch connections.
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("checkGeneratedSchemaDrift", () => {
  test('reports "unmigrated" when platform.schema_migrations does not exist', async () => {
    const drift = await checkGeneratedSchemaDrift(runtime.db);
    expect(drift.status).toBe("unmigrated");
    expect(drift.recordedChecksum).toBeNull();
    expect(drift.bundledChecksum).toBe(manifest.checksum);
  });

  test('reports "unmigrated" when the table exists but has no generated-schema row', async () => {
    await sql`create schema if not exists platform`.execute(runtime.db);
    await sql`
      create table if not exists platform.schema_migrations (
        version text primary key,
        checksum text,
        applied_at timestamptz not null default now(),
        applied_by text
      )
    `.execute(runtime.db);

    const drift = await checkGeneratedSchemaDrift(runtime.db);
    expect(drift.status).toBe("unmigrated");
    expect(drift.recordedChecksum).toBeNull();
  });

  test('reports "behind" when the recorded checksum differs from the bundled manifest', async () => {
    await sql`
      insert into platform.schema_migrations (version, checksum, applied_by)
      values (${GENERATED_SCHEMA_MIGRATION_VERSION}, ${"old"}, ${"schema-drift.test"})
    `.execute(runtime.db);

    const drift = await checkGeneratedSchemaDrift(runtime.db);
    expect(drift.status).toBe("behind");
    expect(drift.recordedChecksum).toBe("old");
    expect(drift.bundledChecksum).toBe(manifest.checksum);
  });

  test('reports "ok" when the recorded checksum equals the bundled manifest', async () => {
    await sql`
      update platform.schema_migrations
      set checksum = ${manifest.checksum}
      where version = ${GENERATED_SCHEMA_MIGRATION_VERSION}
    `.execute(runtime.db);

    const drift = await checkGeneratedSchemaDrift(runtime.db);
    expect(drift.status).toBe("ok");
    expect(drift.recordedChecksum).toBe(manifest.checksum);
    expect(drift.bundledChecksum).toBe(manifest.checksum);
  });
});
