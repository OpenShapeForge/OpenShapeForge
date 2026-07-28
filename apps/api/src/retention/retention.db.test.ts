// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../db/connection.js";
import { applyRetentionControlMigration } from "../db/migrations/retention-control.js";
import {
  enforceRetention,
  type RetentionManifest,
} from "./retention.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 60_000;

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const name = `retention_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

function manifestFor(rules: NonNullable<RetentionManifest["tables"][number]["retention"]>["rules"]): RetentionManifest {
  return {
    tables: [{
      schema: "erp",
      table: "retention_subjects",
      primaryKey: "id",
      columns: [
        { name: "id", type: "uuid", required: true, primaryKey: true },
        { name: "expires_on", type: "date", required: false },
        { name: "updated_at", type: "timestamptz", required: true },
        { name: "email", type: "text", required: false, classification: "pii" },
      ],
      retention: {
        clock: { column: "expires_on", type: "date", fallbackColumns: ["updated_at"] },
        rules,
      },
    }],
  };
}

async function seedSchema(url: string) {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
  await sql`
    create schema erp;
    create table erp.retention_subjects (
      id uuid primary key,
      expires_on date,
      updated_at timestamptz not null,
      email text
    );
  `.execute(runtime.db);
  await applyRetentionControlMigration(runtime.db);
  return runtime;
}

describe("retention enforcement against PostgreSQL", () => {
  test("uses date fallback clocks and routes review without deleting", async () => {
    await withScratchDb(async (url) => {
      const runtime = await seedSchema(url);
      try {
        const id = randomUUID();
        await sql`
          insert into erp.retention_subjects (id, expires_on, updated_at, email)
          values (${id}, null, now() - interval '3 years', 'person@example.test')
        `.execute(runtime.db);

        const result = await runtime.db.transaction().execute((trx) =>
          enforceRetention(trx, manifestFor([{
            id: "review_delete",
            after: { years: 2 },
            action: "delete",
            disposition: "delete",
            review: { required: true, queue: "privacy-review" },
          }]))
        );

        expect(result.reviewed).toBe(1);
        expect((await sql`select 1 from erp.retention_subjects where id = ${id}`.execute(runtime.db)).rows).toHaveLength(1);
        const queued = await sql<{ queue: string; record_id: string }>`
          select queue, record_id from platform.retention_review_queue
        `.execute(runtime.db);
        expect(queued.rows).toEqual([{ queue: "privacy-review", record_id: id }]);
      } finally {
        await runtime.close();
      }
    });
  }, TEST_TIMEOUT);

  test("archives rows, redacts PII, queues crypto-delete, and deletes rows", async () => {
    await withScratchDb(async (url) => {
      const runtime = await seedSchema(url);
      try {
        const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        for (const id of ids) {
          await sql`
            insert into erp.retention_subjects (id, expires_on, updated_at, email)
            values (${id}, current_date - 800, now(), 'person@example.test')
          `.execute(runtime.db);
        }

        const rules = [
          { id: "archive", after: { years: 1 }, action: "archive" as const, disposition: "archive" as const },
        ];
        const archiveResult = await runtime.db.transaction().execute((trx) =>
          enforceRetention(trx, manifestFor(rules), { batchSize: 1 })
        );
        expect(archiveResult.archived).toBe(1);
        expect((await sql`select 1 from platform.retention_archive`.execute(runtime.db)).rows).toHaveLength(1);

        const redactResult = await runtime.db.transaction().execute((trx) =>
          enforceRetention(trx, manifestFor([{
            id: "redact",
            after: { years: 1 },
            action: "redact",
            disposition: "anonymize",
          }]), { batchSize: 1 })
        );
        expect(redactResult.redacted).toBe(1);
        expect((await sql<{ email: string | null }>`select email from erp.retention_subjects where email is null`.execute(runtime.db)).rows).toHaveLength(1);

        const cryptoResult = await runtime.db.transaction().execute((trx) =>
          enforceRetention(trx, manifestFor([{
            id: "crypto",
            after: { years: 1 },
            action: "redact",
            disposition: "cryptoDelete",
            cryptoDelete: { keyReference: "subject-key" },
          }]), { batchSize: 1 })
        );
        expect(cryptoResult.cryptoDeleteQueued).toBe(1);
        expect((await sql`select 1 from platform.retention_crypto_delete_queue`.execute(runtime.db)).rows).toHaveLength(1);

        const deleteResult = await runtime.db.transaction().execute((trx) =>
          enforceRetention(trx, manifestFor([{
            id: "delete",
            after: { years: 1 },
            action: "delete",
            disposition: "delete",
          }]), { batchSize: 1 })
        );
        expect(deleteResult.deleted).toBe(1);
      } finally {
        await runtime.close();
      }
    });
  }, TEST_TIMEOUT);
});
