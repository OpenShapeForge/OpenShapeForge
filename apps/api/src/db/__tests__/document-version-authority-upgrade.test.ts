// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { applyAppHelpersMigration } from "../migrations/app-helpers.js";
import documentVersionAuthority from "../migrations/versioned/0007_document-version-authority.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;

async function withLegacyDatabase<T>(
  fixture: (db: Kysely<DB>) => Promise<void>,
  assertion: (db: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const name = `document_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe scratch database name");
  const admin = new SQL(ADMIN_URL, { max: 1 });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await admin.unsafe(`create database "${name}"`);
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
  try {
    await applyAppHelpersMigration(runtime.db);
    await sql`create schema erp`.execute(runtime.db);
    await sql`
      create table erp.documents (
        id uuid primary key,
        tenant_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        external_id text,
        source_authority text,
        source_organization text,
        source_administration text,
        code text,
        title text not null,
        description text,
        document_type text not null,
        status text not null,
        confidentiality text,
        source text,
        author text,
        is_external boolean not null default false,
        registered_at timestamptz,
        received_at timestamptz,
        published_at timestamptz,
        file_name text,
        mime_type text,
        storage_location text,
        version_label text,
        checksum text,
        case_file_id uuid,
        case_id uuid,
        relation_id uuid,
        current_version_id uuid
      )
    `.execute(runtime.db);
    await sql`
      create table erp.document_versions (
        id uuid primary key,
        tenant_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        external_id text,
        source_authority text,
        source_organization text,
        source_administration text,
        version_label text not null,
        status text not null,
        created_by text,
        file_name text,
        mime_type text,
        storage_location text,
        checksum text,
        is_major_version boolean not null default false,
        change_summary text,
        account_id uuid
      )
    `.execute(runtime.db);
    await fixture(runtime.db);
    return await assertion(runtime.db);
  } finally {
    await runtime.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}

async function columnNames(db: Kysely<DB>, table: string): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = 'erp' and table_name = ${table}
    order by ordinal_position
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

describe("DocumentVersion authority legacy upgrade", () => {
  test("backfills ownership, preserves the artifact, and removes duplicate Document fields", async () => {
    const tenantId = randomUUID();
    const documentId = randomUUID();
    const versionId = randomUUID();
    await withLegacyDatabase(
      async (db) => {
        await sql`
          insert into erp.document_versions (
            id, tenant_id, version_label, status, file_name, mime_type,
            storage_location, checksum
          ) values (
            ${versionId}::uuid, ${tenantId}::uuid, '1.0', 'published',
            'legacy.pdf', 'application/pdf', 'legacy/offer.pdf', 'sha256:legacy'
          )
        `.execute(db);
        await sql`
          insert into erp.documents (
            id, tenant_id, title, document_type, status, current_version_id,
            file_name, mime_type, storage_location, version_label, checksum
          ) values (
            ${documentId}::uuid, ${tenantId}::uuid, 'Legacy offer', 'quote',
            'published', ${versionId}::uuid, 'legacy.pdf', 'application/pdf',
            'legacy/offer.pdf', '1.0', 'sha256:legacy'
          )
        `.execute(db);
      },
      async (db) => {
        await db.transaction().execute((trx) => documentVersionAuthority.up(trx));
        const migrated = await sql<{ document_id: string; checksum: string }>`
          select document_id, checksum
          from erp.document_versions
          where id = ${versionId}::uuid
        `.execute(db);
        expect(migrated.rows[0]).toEqual({
          document_id: documentId,
          checksum: "sha256:legacy",
        });
        const documentColumns = await columnNames(db, "documents");
        for (const removed of ["file_name", "mime_type", "storage_location", "version_label", "checksum"]) {
          expect(documentColumns).not.toContain(removed);
        }
        const nullable = await sql<{ is_nullable: string }>`
          select is_nullable from information_schema.columns
          where table_schema = 'erp'
            and table_name = 'document_versions'
            and column_name = 'document_id'
        `.execute(db);
        expect(nullable.rows[0]?.is_nullable).toBe("NO");
      },
    );
  }, TEST_TIMEOUT);

  test("orphan preflight rolls the destructive upgrade back completely", async () => {
    const tenantId = randomUUID();
    const orphanId = randomUUID();
    await withLegacyDatabase(
      async (db) => {
        await sql`
          insert into erp.document_versions (id, tenant_id, version_label, status, checksum)
          values (${orphanId}::uuid, ${tenantId}::uuid, 'orphan', 'draft', 'sha256:orphan')
        `.execute(db);
      },
      async (db) => {
        let failure: unknown;
        try {
          await db.transaction().execute((trx) => documentVersionAuthority.up(trx));
        } catch (error) {
          failure = error;
        }
        expect((failure as Error).message).toContain("orphan versions exist");
        expect(await columnNames(db, "document_versions")).not.toContain("document_id");
        const documentColumns = await columnNames(db, "documents");
        for (const preserved of ["file_name", "mime_type", "storage_location", "version_label", "checksum"]) {
          expect(documentColumns).toContain(preserved);
        }
        const orphan = await sql<{ checksum: string }>`
          select checksum from erp.document_versions where id = ${orphanId}::uuid
        `.execute(db);
        expect(orphan.rows[0]?.checksum).toBe("sha256:orphan");
      },
    );
  }, TEST_TIMEOUT);
});
