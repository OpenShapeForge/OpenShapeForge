// SPDX-License-Identifier: BUSL-1.1
/**
 * The core invariants a built database carries beyond the manifest
 * (migrations/core-invariants.ts), proven against a throwaway scratch
 * database after the real chain: the tenant-qualified document keys, the
 * managed DocumentType authority, and idempotency across a rerun of the
 * whole chain, which re-applies the invariants over the widened keys. The
 * closure trigger has its own suite
 * (org-unit-closure.test.ts), as do the document commands and the artifact
 * binding.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/core-invariants.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { type Kysely, sql } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { applyCoreInvariants } from "../migrations/core-invariants.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;

async function withScratchDb<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const name = `core_invariants_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") throw new Error("admin URL must not point at openshapeforge_dev");
  url.pathname = `/${name}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    try {
      await runtime.db.connection().execute((conn) => runMigrationChain(conn));
      return await fn(runtime.db);
    } finally {
      await runtime.close();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

function sqlState(error: unknown): string | undefined {
  const postgres = error as { errno?: string; code?: string } | null;
  return postgres?.errno ?? postgres?.code;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Key columns of every foreign key on the document tables, by name. */
async function documentForeignKeys(db: Kysely<DB>): Promise<Record<string, string[]>> {
  const rows = await sql<{ name: string; columns: string[] }>`
    select c.conname as name,
      array_agg(a.attname::text order by k.ordinality) as columns
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f'
      and c.conname in (
        'document_versions_document_id_fkey',
        'documents_current_version_id_fkey',
        'documents_document_type_fkey'
      )
    group by c.conname
  `.execute(db);
  return Object.fromEntries(rows.rows.map((row) => [row.name, row.columns]));
}

const compoundKeys = {
  document_versions_document_id_fkey: ["tenant_id", "document_id"],
  documents_current_version_id_fkey: ["tenant_id", "id", "current_version_id"],
  documents_document_type_fkey: ["tenant_id", "document_type"],
};

describe("core invariants", () => {
  test(
    "widen the generated document keys to tenant-qualified compound keys and keep them so",
    async () => {
      await withScratchDb(async (db) => {
        expect(await documentForeignKeys(db)).toEqual(compoundKeys);

        // A rerun of the invariants is a no-op, not a drop-and-add.
        await applyCoreInvariants(db);
        expect(await documentForeignKeys(db)).toEqual(compoundKeys);

        // A rerun of the whole chain on the built database is the checksum
        // no-op followed by every invariant: the compound keys must survive it.
        const rerun = await db.connection().execute((conn) => runMigrationChain(conn));
        expect(rerun.applied).toBe(false);
        expect(await documentForeignKeys(db)).toEqual(compoundKeys);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "make the managed DocumentType catalog authoritative for a Document's code",
    async () => {
      await withScratchDb(async (db) => {
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        const defaults = await sql<{
          description: string | null;
          default_confidentiality: string | null;
          requires_registration: boolean;
          allows_external_publication: boolean;
        }>`
          insert into erp.document_types (tenant_id, code, name)
          values (${tenantA}::uuid, 'quote', 'Governed quote')
          returning description, default_confidentiality,
            requires_registration, allows_external_publication
        `.execute(db);
        expect(defaults.rows[0]).toEqual({
          description: null,
          default_confidentiality: null,
          requires_registration: true,
          allows_external_publication: false,
        });

        // Known code in the same tenant: accepted.
        expect(
          await rejection(
            sql`
              insert into erp.documents (tenant_id, title, document_type, status)
              values (${tenantA}::uuid, 'Known type', 'quote', 'draft')
            `.execute(db),
          ),
        ).toBeUndefined();

        // The same code from another tenant is not this tenant's type.
        const crossTenant = await rejection(
          sql`
            insert into erp.documents (tenant_id, title, document_type, status)
            values (${tenantB}::uuid, 'Cross-tenant type', 'quote', 'draft')
          `.execute(db),
        );
        expect(sqlState(crossTenant)).toBe("23503");

        // A type in use cannot be deleted from under its Documents.
        const inUseDelete = await rejection(
          sql`
            delete from erp.document_types where tenant_id = ${tenantA}::uuid and code = 'quote'
          `.execute(db),
        );
        expect(sqlState(inUseDelete)).toBe("23503");

        // One row per (tenant, code).
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
});
