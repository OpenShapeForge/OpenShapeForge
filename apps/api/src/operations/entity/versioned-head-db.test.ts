// SPDX-License-Identifier: BUSL-1.1
/**
 * The draft rule's walk up the bound ownership tree, on a scratch schema
 * built by hand: a head owns two branches that converge on one leaf table.
 * A leaf row with one owner column set resolves along that branch; a row set
 * along both is refused as ambiguous; every real change advances the head's
 * version token, the lifecycle move is only the first change's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import type { GeneratedCrudTable } from "./types.js";
import { draftOwningHead } from "./versioned-head.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `versioned_head_${randomUUID().replaceAll("-", "")}`;
let admin: SQL | undefined, runtime: DatabaseRuntime | undefined;
const tenant = randomUUID();

const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, required: false, primaryKey: false, ...extra });
const owned = (table: string, fk: string, children: unknown[] = []) => ({ schema: "erp", table, childColumns: ["tenant_id", fk], parentColumns: ["tenant_id", "id"], children });
function table(name: string, columns: ReturnType<typeof column>[], versioning?: { owned: unknown[] }): GeneratedCrudTable {
  return {
    name: `erp.${name}`, schema: "erp", table: name, tenantScoped: true, domainInternal: false, generatedCrud: true, primaryKey: "id",
    columns: [column("id", "uuid", { primaryKey: true }), column("tenant_id", "uuid"), column("updated_at", "timestamptz"), ...columns],
    source: {
      authoringEntityName: name,
      ...(versioning ? { versioning: {
        strategy: "publishedSnapshot", versionEntity: "HeadVersion", versionsField: "versions", snapshot: { ownedRelationships: "recursive" },
        publishOperation: "Head.publish", onEdit: { field: "lifecycleStatus", value: "draft" },
        storage: { head: { schema: "erp", table: name }, version: { schema: "erp", table: "head_versions", headColumn: "head_id" }, owned: versioning.owned as never },
      } } : {}),
    },
  } as unknown as GeneratedCrudTable;
}
const tables: GeneratedCrudTable[] = [
  table("heads", [column("lifecycle_status", "text", { sourceField: "lifecycleStatus" })], { owned: [owned("lefts", "head_id", [owned("leaves", "left_id")]), owned("rights", "head_id", [owned("leaves", "right_id")])] }),
  table("lefts", [column("head_id", "uuid")]),
  table("rights", [column("head_id", "uuid")]),
  table("leaves", [column("left_id", "uuid"), column("right_id", "uuid")]),
];
const leaves = tables[3]!;
const head = async (id: string) => (await sql<{ lifecycle_status: string; updated_at: string }>`select lifecycle_status, updated_at::text as updated_at from erp.heads where id = ${id}::uuid`.execute(runtime!.db)).rows[0]!;

describe("the draft rule's walk to the owning head", () => {
  beforeAll(async () => {
    admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    const url = new URL(adminUrl); url.pathname = `/${scratchName}`;
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await sql`create schema erp;
      create table erp.heads(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, lifecycle_status text not null default 'published', updated_at timestamptz not null default clock_timestamp());
      create table erp.lefts(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, head_id uuid not null, updated_at timestamptz not null default clock_timestamp());
      create table erp.rights(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, head_id uuid not null, updated_at timestamptz not null default clock_timestamp());
      create table erp.leaves(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, left_id uuid, right_id uuid, updated_at timestamptz not null default clock_timestamp())`.execute(runtime.db);
  }, 30_000);
  beforeEach(async () => { await sql`truncate erp.leaves, erp.lefts, erp.rights, erp.heads`.execute(runtime!.db); });
  afterAll(async () => {
    await runtime?.close();
    await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  async function seed() {
    const headId = randomUUID(), leftId = randomUUID(), rightId = randomUUID();
    await sql`insert into erp.heads(id, tenant_id) values (${headId}::uuid, ${tenant}::uuid)`.execute(runtime!.db);
    await sql`insert into erp.lefts(id, tenant_id, head_id) values (${leftId}::uuid, ${tenant}::uuid, ${headId}::uuid)`.execute(runtime!.db);
    await sql`insert into erp.rights(id, tenant_id, head_id) values (${rightId}::uuid, ${tenant}::uuid, ${headId}::uuid)`.execute(runtime!.db);
    return { headId, leftId, rightId };
  }

  test("a leaf resolves along whichever branch its owner column names, and every change advances the head's token", async () => {
    const { headId, leftId, rightId } = await seed();
    await runtime!.db.transaction().execute(async (trx) => {
      await draftOwningHead(trx, tables, leaves, { tenant_id: tenant, left_id: leftId, right_id: null });
    });
    const first = await head(headId);
    expect(first.lifecycle_status).toBe("draft");
    await runtime!.db.transaction().execute(async (trx) => {
      await draftOwningHead(trx, tables, leaves, { tenant_id: tenant, left_id: null, right_id: rightId });
    });
    const second = await head(headId);
    expect(second.lifecycle_status).toBe("draft");
    // Already draft, yet the version token moved: a publisher holding `first.updated_at` can no longer publish this content unseen.
    expect(second.updated_at).not.toBe(first.updated_at);
  });

  test("a leaf set along both converging branches is refused as ambiguous, and one owned by nothing is left alone", async () => {
    const { headId, leftId, rightId } = await seed();
    await expect(runtime!.db.transaction().execute(async (trx) => {
      await draftOwningHead(trx, tables, leaves, { tenant_id: tenant, left_id: leftId, right_id: rightId });
    })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    const before = await head(headId);
    await runtime!.db.transaction().execute(async (trx) => {
      await draftOwningHead(trx, tables, leaves, { tenant_id: tenant, left_id: null, right_id: null });
      await draftOwningHead(trx, tables, leaves, { tenant_id: tenant, left_id: randomUUID(), right_id: null });
    });
    expect(await head(headId)).toEqual(before);
  });
});
