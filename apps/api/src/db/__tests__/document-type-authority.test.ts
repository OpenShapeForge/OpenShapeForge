// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { type Kysely, sql } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { applyAppHelpersMigration } from "../migrations/app-helpers.js";
import documentVersionAuthority from "../migrations/versioned/0007_document-version-authority.js";
import documentTypeAuthority from "../migrations/versioned/0015_document-type-authority.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;

async function withScratchDb<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const name = `document_types_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    const url = new URL(ADMIN_URL);
    if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") {
      throw new Error("admin URL must not point at an application database");
    }
    url.pathname = `/${name}`;
    const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    try {
      return await fn(runtime.db);
    } finally {
      await runtime.close();
    }
  } finally {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}

async function apply0007(db: Kysely<DB>): Promise<void> {
  await applyAppHelpersMigration(db);
  await db.transaction().execute((trx) => documentVersionAuthority.up(trx));
  await sql`create table erp.case_files (id uuid primary key, tenant_id uuid not null)`.execute(db);
  await sql`create table erp.cases (id uuid primary key, tenant_id uuid not null)`.execute(db);
  await sql`create table erp.relations (id uuid primary key, tenant_id uuid not null)`.execute(db);
}

async function apply0015(db: Kysely<DB>): Promise<void> {
  await db.transaction().execute((trx) => documentTypeAuthority.up(trx));
}

async function createLegacyDocumentTypes(db: Kysely<DB>): Promise<void> {
  await sql`
    create table erp.document_types (
      id uuid primary key not null default gen_random_uuid(),
      tenant_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      external_id text,
      source_authority text,
      source_organization text,
      source_administration text,
      code text not null,
      name text not null,
      description text,
      default_confidentiality text,
      requires_registration boolean not null default true,
      allows_external_publication boolean not null default false
    )
  `.execute(db);
}

function sqlState(error: unknown): string | undefined {
  const value = error as { code?: unknown; errno?: unknown };
  const state = value?.errno ?? value?.code;
  return typeof state === "string" ? state : undefined;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("managed DocumentType authority migration", () => {
  test(
    "creates an empty authoritative catalog foundation on a fresh database",
    async () => {
      await withScratchDb(async (db) => {
        await apply0007(db);
        await apply0015(db);
        const state = await sql<{
          rows: string;
          code_index: string | null;
          identity_index: string | null;
          foreign_key: string | null;
        }>`
          select
            (select count(*)::text from erp.document_types) as rows,
            to_regclass('erp.document_types_tenant_code_uidx')::text as code_index,
            to_regclass('erp.document_types_tenant_identity_uidx')::text as identity_index,
            (
              select conname from pg_constraint
              where conrelid = 'erp.documents'::regclass
                and conname = 'documents_document_type_fkey'
            ) as foreign_key
        `.execute(db);
        expect(state.rows[0]).toEqual({
          rows: "0",
          code_index: "erp.document_types_tenant_code_uidx",
          identity_index: "erp.document_types_tenant_identity_uidx",
          foreign_key: "documents_document_type_fkey",
        });

        const tenantId = randomUUID();
        const defaults = await sql<{
          description: string | null;
          default_confidentiality: string | null;
          requires_registration: boolean;
          allows_external_publication: boolean;
        }>`
          insert into erp.document_types (tenant_id, code, name)
          values (${tenantId}::uuid, 'custom', 'Custom')
          returning description, default_confidentiality,
            requires_registration, allows_external_publication
        `.execute(db);
        expect(defaults.rows[0]).toEqual({
          description: null,
          default_confidentiality: null,
          requires_registration: true,
          allows_external_publication: false,
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "bootstraps nine base codes without overwriting managed product types or existing metadata",
    async () => {
      await withScratchDb(async (db) => {
        await apply0007(db);
        await createLegacyDocumentTypes(db);
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const tenantWithoutDocuments = randomUUID();
        const quoteId = randomUUID();
        const incomingId = randomUUID();
        const pentestId = randomUUID();

        await sql`
          insert into erp.document_types (
            id, tenant_id, code, name, description, default_confidentiality,
            requires_registration, allows_external_publication
          ) values
            (${quoteId}::uuid, ${tenantA}::uuid, 'quote', 'Governed quote', 'Preserve me',
              'confidential', false, true),
            (${incomingId}::uuid, ${tenantA}::uuid, 'incoming_mail', 'Tenant label', 'Tenant metadata',
              'internal', false, true),
            (${pentestId}::uuid, ${tenantWithoutDocuments}::uuid, 'pentest-report',
              'Pentest report', null, null, true, false)
        `.execute(db);
        await sql`
          insert into erp.documents (tenant_id, title, document_type, status) values
            (${tenantA}::uuid, 'Existing base document', 'incoming_mail', 'draft'),
            (${tenantA}::uuid, 'Existing product document', 'quote', 'draft'),
            (${tenantB}::uuid, 'Second tenant document', 'report', 'draft');
        `.execute(db);

        await apply0015(db);

        const counts = await sql<{ tenant_id: string; count: string }>`
          select tenant_id::text, count(*)::text
          from erp.document_types
          group by tenant_id
          order by tenant_id
        `.execute(db);
        expect(new Map(counts.rows.map((row) => [row.tenant_id, row.count]))).toEqual(
          new Map([
            [tenantA, "10"],
            [tenantB, "9"],
            [tenantWithoutDocuments, "1"],
          ]),
        );

        const preserved = await sql<{
          id: string;
          name: string;
          description: string | null;
          default_confidentiality: string | null;
          requires_registration: boolean;
          allows_external_publication: boolean;
        }>`
          select id::text, name, description, default_confidentiality,
            requires_registration, allows_external_publication
          from erp.document_types
          where tenant_id = ${tenantA}::uuid and code = 'incoming_mail'
        `.execute(db);
        expect(preserved.rows[0]).toEqual({
          id: incomingId,
          name: "Tenant label",
          description: "Tenant metadata",
          default_confidentiality: "internal",
          requires_registration: false,
          allows_external_publication: true,
        });

        const product = await sql<{ id: string; description: string | null }>`
          select id::text, description from erp.document_types
          where tenant_id = ${tenantA}::uuid and code = 'quote'
        `.execute(db);
        expect(product.rows[0]).toEqual({ id: quoteId, description: "Preserve me" });

        const knownInsert = await rejection(
          sql`
          insert into erp.documents (tenant_id, title, document_type, status)
          values (${tenantB}::uuid, 'Known type', 'decision', 'draft')
        `.execute(db),
        );
        expect(knownInsert).toBeUndefined();

        const unknown = await rejection(
          sql`
          insert into erp.documents (tenant_id, title, document_type, status)
          values (${tenantB}::uuid, 'Cross-tenant type', 'quote', 'draft')
        `.execute(db),
        );
        expect(sqlState(unknown)).toBe("23503");

        const inUseDelete = await rejection(
          sql`
          delete from erp.document_types
          where tenant_id = ${tenantA}::uuid and code = 'incoming_mail'
        `.execute(db),
        );
        expect(sqlState(inUseDelete)).toBe("23503");

        const duplicate = await rejection(
          sql`
          insert into erp.document_types (tenant_id, code, name)
          values (${tenantA}::uuid, 'quote', 'Duplicate quote')
        `.execute(db),
        );
        expect(sqlState(duplicate)).toBe("23505");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses duplicate or unregistered upgrade data without normalizing it",
    async () => {
      await withScratchDb(async (db) => {
        await apply0007(db);
        await createLegacyDocumentTypes(db);
        const tenantId = randomUUID();
        await sql`
          insert into erp.document_types (tenant_id, code, name) values
            (${tenantId}::uuid, 'note', 'First'),
            (${tenantId}::uuid, 'note', 'Second')
        `.execute(db);
        const duplicate = await rejection(apply0015(db));
        expect(duplicate).toBeInstanceOf(Error);
        expect((duplicate as Error).message).toContain("duplicate tenant/code rows exist");
        const after = await sql<{ count: string }>`
          select count(*)::text from erp.document_types
        `.execute(db);
        expect(after.rows[0]?.count).toBe("2");
      });

      await withScratchDb(async (db) => {
        await apply0007(db);
        await createLegacyDocumentTypes(db);
        const tenantId = randomUUID();
        await sql`
          insert into erp.documents (tenant_id, title, document_type, status)
          values (${tenantId}::uuid, 'Unknown legacy type', 'legacy_custom', 'draft')
        `.execute(db);
        const unknown = await rejection(apply0015(db));
        expect(unknown).toBeInstanceOf(Error);
        expect((unknown as Error).message).toContain(
          "an existing Document code has no managed DocumentType in the same tenant",
        );
        const seedRows = await sql<{ count: string }>`
          select count(*)::text from erp.document_types
        `.execute(db);
        expect(seedRows.rows[0]?.count).toBe("0");
      });
    },
    TEST_TIMEOUT,
  );
});
