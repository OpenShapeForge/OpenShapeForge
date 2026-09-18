// SPDX-License-Identifier: BUSL-1.1
/**
 * Generic delete of a collection owner against PostgreSQL: refused while an
 * owned child row exists, ordinary once none do. Uses the one owner in the
 * compiled catalog whose generic delete is enabled, Document → DocumentVariant
 * (document_variants.document_id). The scratch schema mirrors the catalog's
 * shape by hand, so the child table is what the catalog names. The owned
 * child's own generic delete is refused statically; collection-policy.test.ts
 * covers that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { deleteGeneratedEntity } from "./mutations.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `owner_delete_${randomUUID().replaceAll("-", "")}`;
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
let created = false;
const tenant = randomUUID(), actor = randomUUID();
const session = { tenantId: tenant, userId: actor, scope: "self" as const, roles: ["CaseFile.All.ReadWrite"] };

function databaseUrl(app = false) {
  const url = new URL(adminUrl!);
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}
async function seed(children: number) {
  const id = randomUUID();
  await sql`insert into erp.documents(id, tenant_id, title) values (${id}::uuid, ${tenant}::uuid, 'Owner')`.execute(privileged!.db);
  for (let index = 0; index < children; index++) {
    await sql`insert into erp.document_variants(id, tenant_id, document_id, locale) values (${randomUUID()}::uuid, ${tenant}::uuid, ${id}::uuid, ${index === 0 ? "nl" : "en"})`.execute(privileged!.db);
  }
  return id;
}
async function count(table: "documents" | "document_variants") {
  return (await sql<{ count: number }>`select count(*)::int as count from ${sql.id("erp", table)}`.execute(privileged!.db)).rows[0]!.count;
}
const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ operationError: { code } });

(adminUrl ? describe : describe.skip)("generic delete of a collection owner against PostgreSQL", () => {
  beforeAll(async () => {
    admin = new SQL(adminUrl!, { max: 1 });
    const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
    if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) throw new Error("An existing restricted app role is required; shared roles are never changed.");
    await admin.unsafe(`create database "${scratchName}"`); created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
    await applyAppHelpersMigration(privileged.db);
    await sql`create schema erp; create schema platform;
      create table erp.documents(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, title text not null,
        document_type text not null default 'letter', status text not null default 'draft', is_external boolean not null default false,
        created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(), unique(tenant_id,id));
      create table erp.document_variants(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, document_id uuid not null,
        channel text not null default 'document', locale text not null default 'nl',
        created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
        unique(tenant_id,id), unique(tenant_id,document_id,channel,locale), foreign key(tenant_id,document_id) references erp.documents(tenant_id,id) on delete cascade);
      create table platform.entity_events(id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
        aggregate_type text not null, aggregate_id text not null, event_type text not null, payload jsonb,
        sequence bigint generated always as identity, occurred_at timestamptz not null);
      alter table erp.documents enable row level security; alter table erp.documents force row level security;
      alter table erp.document_variants enable row level security; alter table erp.document_variants force row level security;
      create policy tenant on erp.documents using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on erp.document_variants using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      grant usage on schema app, erp, platform to openshapeforge_app;
      grant select,insert,update,delete on all tables in schema erp,platform to openshapeforge_app;
      grant usage on all sequences in schema platform to openshapeforge_app;
      grant execute on all functions in schema app to openshapeforge_app`.execute(privileged.db);
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 2 });
  }, 30_000);
  beforeEach(async () => {
    await sql`truncate erp.document_variants, erp.documents, platform.entity_events`.execute(privileged!.db);
  });
  afterAll(async () => {
    await restricted?.close(); await privileged?.close();
    if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("is refused while owned children exist, even though the FK would cascade", async () => {
    const owner = await seed(2);
    await fails(deleteGeneratedEntity(restricted!.db, session, { table: "erp.documents", id: owner }), "RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    expect(await count("documents")).toBe(1);
    expect(await count("document_variants")).toBe(2);
    expect((await sql<{ count: number }>`select count(*)::int as count from platform.entity_events`.execute(privileged!.db)).rows[0]!.count).toBe(0);
  });

  test("succeeds once the owner has no owned children", async () => {
    const owner = await seed(1);
    await sql`delete from erp.document_variants where document_id = ${owner}::uuid`.execute(privileged!.db);
    expect(await deleteGeneratedEntity(restricted!.db, session, { table: "erp.documents", id: owner })).toBe(true);
    expect(await count("documents")).toBe(0);
    expect((await sql<{ count: number }>`select count(*)::int as count from platform.entity_events where event_type = 'deleted'`.execute(privileged!.db)).rows[0]!.count).toBe(1);
  });
});
