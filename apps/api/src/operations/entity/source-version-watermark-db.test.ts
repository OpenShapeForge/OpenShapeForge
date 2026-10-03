// SPDX-License-Identifier: BUSL-1.1
/**
 * The incremental-import watermark is not stored anywhere: it is the highest
 * `sourceVersion` among records of one source and administration, read with
 * the ordinary list ("filter by source, sort sourceVersion desc, take one").
 * This proves that read against PostgreSQL — including that an unversioned
 * row (NULL) never sorts above a real version on desc.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { listGeneratedEntityStorageRowsForTable } from "./queries.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `source_version_${randomUUID().replaceAll("-", "")}`;
let admin: SQL | undefined, runtime: DatabaseRuntime | undefined;
const tenantId = randomUUID(), otherTenant = randomUUID();
const session = { tenantId, userId: randomUUID(), scope: "self" as const, roles: [] };

const column = (name: string, sourceField: string, type = "text"): GeneratedCrudColumn =>
  ({ name, sourceField, type, required: name === "id", primaryKey: name === "id", generated: null });
const table: GeneratedCrudTable = {
  name: "erp.ledger_postings", schema: "erp", table: "ledger_postings", tenantScoped: true,
  domainInternal: false, generatedCrudEligible: true, primaryKey: "id",
  columns: [
    column("id", "id", "uuid"),
    column("tenant_id", "tenantId", "uuid"),
    column("source_authority", "sourceAuthority"),
    column("source_administration", "sourceAdministration"),
    column("source_version", "sourceVersion"),
  ],
};

async function watermark(authority: string, administration: string) {
  const page = await listGeneratedEntityStorageRowsForTable(runtime!.db, session, table, {
    filter: { sourceAuthority: authority, sourceAdministration: administration },
    sort: { field: "sourceVersion", direction: "desc" },
    limit: 1,
  });
  return page.rows[0]?.source_version ?? null;
}

describe("sourceVersion watermark", () => {
  beforeAll(async () => {
    admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    const url = new URL(adminUrl); url.pathname = `/${scratchName}`;
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await applyAppHelpersMigration(runtime.db);
    await sql`create schema erp; create table erp.ledger_postings(
      id uuid primary key, tenant_id uuid not null, source_authority text, source_administration text, source_version text)`.execute(runtime.db);
    const rows: Array<[string, string, string | null, string?]> = [
      ["acme-erp", "123", "00000000000000999999", otherTenant],
      ["acme-erp", "123", "00000000000000000009"],
      ["acme-erp", "123", "00000000000000000100"],
      ["acme-erp", "123", null],
      ["acme-erp", "456", "00000000000000099999"],
      ["other-ledger", "123", "2026-09-26T10:00:00.000Z"],
    ];
    for (const [authority, administration, version, tenant = tenantId] of rows) {
      await sql`insert into erp.ledger_postings values (${randomUUID()}::uuid, ${tenant}::uuid, ${authority}, ${administration}, ${version})`
        .execute(runtime.db);
    }
  }, 30_000);
  afterAll(async () => {
    await runtime?.close();
    await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("is the highest version of that source and administration in this tenant, never an unversioned row", async () => {
    expect(await watermark("acme-erp", "123")).toBe("00000000000000000100");
    expect(await watermark("acme-erp", "456")).toBe("00000000000000099999");
    expect(await watermark("other-ledger", "123")).toBe("2026-09-26T10:00:00.000Z");
  });

  test("is absent for a source that has not imported yet, so the first run is a full read", async () => {
    expect(await watermark("acme-erp", "789")).toBeNull();
  });
});
