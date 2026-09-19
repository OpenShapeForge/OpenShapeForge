// SPDX-License-Identifier: BUSL-1.1
/**
 * The two ways a database comes into being in the reset model, each against
 * a throwaway scratch database on the same Postgres instance (created and
 * dropped through the admin URL; no shared database is touched):
 *
 *   - `bootstrapIfEmpty` builds an EMPTY database from the manifest once,
 *     and leaves a built, stale or foreign one exactly as it found it;
 *   - `bun run db:reset` drops the target, recreates it and builds it — and
 *     refuses without the confirmation naming that database, or in
 *     production, before touching anything.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/reset-bootstrap.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { type Kysely, sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { DB } from "../../generated/db/types.js";
import { enforceGeneratedSchemaFreshness } from "../../roles/api-readiness.js";
import { bootstrapIfEmpty } from "../bootstrap.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { generatedSchemaMigrationVersion } from "../migrations/generated-schema.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 120_000;
const API_DIR = fileURLToPath(new URL("../../../", import.meta.url));

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (url: string, name: string) => Promise<T>): Promise<T> {
  const name = `reset_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(scratchUrl(name), name);
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 2 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function recordedChecksum(db: Kysely<DB>): Promise<string | null> {
  const ledger = await sql<{ present: boolean }>`
    select to_regclass('platform.schema_migrations') is not null as present
  `.execute(db);
  if (!ledger.rows[0]?.present) return null;
  const result = await sql<{ checksum: string }>`
    select checksum from platform.schema_migrations where version = ${generatedSchemaMigrationVersion}
  `.execute(db);
  return result.rows[0]?.checksum ?? null;
}

async function tableExists(db: Kysely<DB>, qualified: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select to_regclass(${qualified}) is not null as present
  `.execute(db);
  return result.rows[0]?.present ?? false;
}

describe("bootstrapIfEmpty", () => {
  test(
    "builds an empty database from the manifest once, then finds it built",
    async () => {
      await withScratchDb(async (url) => {
        const first = await withDb(url, (db) => bootstrapIfEmpty(db));
        expect(first.bootstrapped).toBe(true);
        if (first.bootstrapped) {
          expect(first.result.applied).toBe(true);
          expect(first.result.checksum).toBe(manifest.checksum);
        }
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db)).toBe(manifest.checksum);
          expect(await tableExists(db, "erp.relations")).toBe(true);
          expect(await tableExists(db, "platform.identity_relations")).toBe(true);
        });

        // A built database is left alone: no second chain run, no DDL.
        const second = await withDb(url, (db) => bootstrapIfEmpty(db));
        expect(second).toMatchObject({ bootstrapped: false, reason: "migrated" });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "leaves a database built from another manifest, and a foreign one, for db:reset",
    async () => {
      await withScratchDb(async (url) => {
        await withDb(url, (db) => db.connection().execute((conn) => runMigrationChain(conn)));
        await withDb(url, async (db) => {
          await sql`
            update platform.schema_migrations set checksum = ${"built-elsewhere"}
            where version = ${generatedSchemaMigrationVersion}
          `.execute(db);
        });
        // Behind is drift, not emptiness: bootstrap does not build over it,
        // and the stale record survives to be reported.
        const stale = await withDb(url, (db) => bootstrapIfEmpty(db));
        expect(stale).toMatchObject({ bootstrapped: false, reason: "behind" });
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db)).toBe("built-elsewhere");
        });
      });

      await withScratchDb(async (url) => {
        // No generated-schema record, but a table in a manifest-covered
        // schema the manifest does not declare: another branch's database, or
        // a legacy layout. Building the manifest over it would leave a
        // database no manifest describes, so nothing is created.
        await withDb(url, async (db) => {
          await sql`create schema platform`.execute(db);
          await sql`create table platform.legacy_ledger (id uuid primary key)`.execute(db);
        });
        const foreign = await withDb(url, (db) => bootstrapIfEmpty(db));
        expect(foreign).toMatchObject({
          bootstrapped: false,
          reason: "foreign-schema",
          undeclared: { tables: ["platform.legacy_ledger"], columns: [] },
        });
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db)).toBeNull();
          expect(await tableExists(db, "erp.relations")).toBe(false);
        });
      });
    },
    TEST_TIMEOUT,
  );
});

/** A logger that keeps what the startup check said, for assertions. */
function recordingLogger() {
  const lines: { level: string; message: string }[] = [];
  const record = (level: string) => (first: unknown, second?: unknown) => {
    lines.push({ level, message: typeof first === "string" ? first : String(second ?? "") });
  };
  const log = {
    fatal: record("fatal"),
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    debug: record("debug"),
    trace: record("trace"),
    silent: record("silent"),
    level: "info",
    child: () => log,
  };
  return { log: log as unknown as Parameters<typeof enforceGeneratedSchemaFreshness>[0], lines };
}

describe("API startup on an empty database", () => {
  test(
    "bootstraps it through the migrate URL, and only when that names the same database",
    async () => {
      await withScratchDb(async (url) => {
        // The startup check runs as the RESTRICTED runtime role would; the
        // build itself goes through the privileged migrate URL, here the same
        // admin connection re-pointed at the scratch database.
        const elsewhere = new URL(url);
        elsewhere.pathname = "/openshapeforge_somewhere_else";
        const skipped = recordingLogger();
        await withDb(url, (db) =>
          enforceGeneratedSchemaFreshness(skipped.log, db, {
            databaseUrl: url,
            env: { OPENSHAPEFORGE_MIGRATE_DATABASE_URL: elsewhere.toString() },
          }),
        );
        expect(skipped.lines.some((line) => line.message.includes("names a different database"))).toBe(true);
        expect(skipped.lines.some((line) => line.message.includes("GENERATED SCHEMA DRIFT DETECTED"))).toBe(true);
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db)).toBeNull();
        });

        const built = recordingLogger();
        await withDb(url, (db) =>
          enforceGeneratedSchemaFreshness(built.log, db, {
            databaseUrl: url,
            env: { OPENSHAPEFORGE_MIGRATE_DATABASE_URL: url },
          }),
        );
        expect(built.lines.some((line) => line.message.includes("Empty database bootstrapped"))).toBe(true);
        expect(built.lines.some((line) => line.message.includes("GENERATED SCHEMA DRIFT DETECTED"))).toBe(false);
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db)).toBe(manifest.checksum);
          expect(await tableExists(db, "erp.relations")).toBe(true);
        });
      });
    },
    TEST_TIMEOUT,
  );
});

type ResetRun = { exitCode: number; stdout: string; stderr: string };

/**
 * `bun run db:reset` as an operator runs it: a separate process with the
 * environment of the job, nothing inherited from this test's own shell that
 * could confirm or redirect the reset by accident.
 */
async function runReset(env: Record<string, string>): Promise<ResetRun> {
  const inherited = { ...process.env };
  for (const key of [
    "NODE_ENV",
    "DATABASE_URL",
    "OPENSHAPEFORGE_MIGRATE_DATABASE_URL",
    "OPENSHAPEFORGE_ADMIN_DATABASE_URL",
    "OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION",
    "OPENSHAPEFORGE_RESET_MAINTENANCE_DATABASE",
  ]) {
    delete inherited[key];
  }
  const child = Bun.spawn(["bun", "src/db/reset.ts"], {
    cwd: API_DIR,
    env: { ...inherited, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("db:reset", () => {
  test(
    "drops, recreates and rebuilds the target, and refuses before touching anything",
    async () => {
      await withScratchDb(async (url, name) => {
        await withDb(url, (db) => db.connection().execute((conn) => runMigrationChain(conn)));
        const marker = randomUUID();
        const plantMarker = () =>
          withDb(url, async (db) => {
            await sql`
              insert into platform.system_bypass_audit (actor_subject, reason, started_at)
              values (${marker}, ${"reset round trip"}, now())
            `.execute(db);
          });
        const markerPresent = () =>
          withDb(url, async (db) => {
            const rows = await sql<{ n: number }>`
              select count(*)::int as n from platform.system_bypass_audit where actor_subject = ${marker}
            `.execute(db);
            return (rows.rows[0]?.n ?? 0) > 0;
          });
        await plantMarker();

        // Refused: no confirmation. The row is still there.
        const unconfirmed = await runReset({ OPENSHAPEFORGE_MIGRATE_DATABASE_URL: url });
        expect(unconfirmed.exitCode).toBe(1);
        expect(unconfirmed.stderr).toContain("OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION is not set");
        expect(unconfirmed.stderr).toContain(name);
        expect(await markerPresent()).toBe(true);

        // Refused: a confirmation copied from another environment.
        const mismatched = await runReset({
          OPENSHAPEFORGE_MIGRATE_DATABASE_URL: url,
          OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION: "openshapeforge_dev",
        });
        expect(mismatched.exitCode).toBe(1);
        expect(mismatched.stderr).toContain("must match exactly");
        expect(await markerPresent()).toBe(true);

        // Refused: production, even with the right confirmation.
        const production = await runReset({
          NODE_ENV: "production",
          OPENSHAPEFORGE_MIGRATE_DATABASE_URL: url,
          OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION: name,
        });
        expect(production.exitCode).toBe(1);
        expect(production.stderr).toContain("production");
        expect(await markerPresent()).toBe(true);

        // The reset itself: the row is gone, the schema is back, the
        // checksum is the bundled one, and a second run is idempotent.
        const reset = await runReset({
          OPENSHAPEFORGE_MIGRATE_DATABASE_URL: url,
          OPENSHAPEFORGE_ADMIN_DATABASE_URL: "",
          OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION: name,
        });
        expect(reset.stderr).toBe("");
        expect(reset.exitCode).toBe(0);
        expect(reset.stdout).toContain(`recreated database "${name}"`);
        const report = JSON.parse(reset.stdout.slice(reset.stdout.indexOf("{")));
        expect(report).toMatchObject({
          reset: name,
          migration: generatedSchemaMigrationVersion,
          checksum: manifest.checksum,
          applied: true,
        });
        expect(await markerPresent()).toBe(false);
        await withDb(url, async (db) => {
          expect(await recordedChecksum(db)).toBe(manifest.checksum);
          expect(await tableExists(db, "erp.relations")).toBe(true);
        });
      });
    },
    TEST_TIMEOUT,
  );
});
