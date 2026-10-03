// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { assertHardDeleteAllowedInTransaction } from "./deletion-guards.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `delete_guards_${randomUUID().replaceAll("-", "")}`;
let admin: SQL | undefined, runtime: DatabaseRuntime | undefined;
const tenantId = randomUUID(), userId = randomUUID();
const session = { tenantId, userId, scope: "self" as const, roles: [] };

const versionTable: GeneratedCrudTable = {
  name: "erp.document_type_versions", schema: "erp", table: "document_type_versions",
  tenantScoped: true, domainInternal: false, generatedCrudEligible: false, primaryKey: "id", columns: [],
};

function table(options: { minimum?: boolean; maximum?: boolean; hold?: boolean; publication?: boolean }): GeneratedCrudTable {
  return {
    name: "erp.records", schema: "erp", table: "records", tenantScoped: true,
    domainInternal: false, generatedCrudEligible: true, primaryKey: "id", columns: [],
    ...(options.minimum || options.maximum || options.hold ? {
      retention: {
        clock: { column: "retention_at", type: "timestamptz" },
        rules: [{
          id: "retention",
          duration: {
            ...(options.minimum ? { minimum: { years: 1 } } : {}),
            ...(options.maximum ? { maximum: { years: 10 } } : {}),
          },
          action: "delete",
          disposition: "delete",
        }],
        ...(options.hold ? { legalHold: { suspendDestruction: true, activeColumn: "legal_hold" } } : {}),
      },
    } : {}),
    source: {
      authoringEntityName: "DocumentType",
      ...(options.publication ? {
        hardDelete: { requireNeverPublished: true },
        versioning: {
          strategy: "publishedSnapshot", versionEntity: "DocumentTypeVersion", versionsField: "versions",
          snapshot: { ownedRelationships: "recursive" }, publishOperation: "DocumentType.publish",
          onEdit: { field: "lifecycleStatus", value: "draft" },
          storage: {
            head: { schema: "erp", table: "records" },
            version: { schema: "erp", table: "document_type_versions", headColumn: "document_type_id" },
            owned: [],
          },
        },
      } : {}),
    },
  };
}

async function allows(definition: GeneratedCrudTable, id: string, row: GeneratedEntityRow) {
  return runtime!.db.transaction().execute((trx) =>
    assertHardDeleteAllowedInTransaction(trx, session, definition, id, row, [definition, versionTable]));
}

describe("canonical hard-delete guards", () => {
  beforeAll(async () => {
    admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    const url = new URL(adminUrl); url.pathname = `/${scratchName}`;
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await sql`create schema erp;
      create table erp.document_type_versions(
        id uuid primary key, tenant_id uuid not null, document_type_id uuid not null
      )`.execute(runtime.db);
  }, 30_000);
  afterAll(async () => {
    await runtime?.close();
    await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("allows a clock that has not started and a maximum-only early deletion", async () => {
    await expect(allows(table({ minimum: true }), randomUUID(), { retention_at: null })).resolves.toBeUndefined();
    await expect(allows(table({ maximum: true }), randomUUID(), { retention_at: new Date().toISOString() })).resolves.toBeUndefined();
  });

  test("blocks an active minimum and allows it after it elapsed", async () => {
    await expect(allows(table({ minimum: true }), randomUUID(), { retention_at: new Date().toISOString() }))
      .rejects.toMatchObject({ operationError: { code: "OPERATION_REFUSED" } });
    await expect(allows(table({ minimum: true }), randomUUID(), { retention_at: "2020-01-01T00:00:00.000Z" }))
      .resolves.toBeUndefined();
  });

  test("blocks only an actual active legal hold", async () => {
    await expect(allows(table({ maximum: true, hold: true }), randomUUID(), { retention_at: null, legal_hold: false }))
      .resolves.toBeUndefined();
    await expect(allows(table({ maximum: true, hold: true }), randomUUID(), { retention_at: null, legal_hold: true }))
      .rejects.toMatchObject({ operationError: { code: "OPERATION_REFUSED" } });
  });

  test("uses durable publication history rather than the current lifecycle label", async () => {
    const id = randomUUID();
    await expect(allows(table({ publication: true }), id, { lifecycle_status: "published" })).resolves.toBeUndefined();
    await sql`insert into erp.document_type_versions(id, tenant_id, document_type_id)
      values (${randomUUID()}::uuid, ${tenantId}::uuid, ${id}::uuid)`.execute(runtime!.db);
    await expect(allows(table({ publication: true }), id, { lifecycle_status: "draft" }))
      .rejects.toMatchObject({ operationError: { code: "OPERATION_REFUSED" } });
  });
});
