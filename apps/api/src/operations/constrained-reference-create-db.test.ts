// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { applyAppHelpersMigration } from "../db/migrations/app-helpers.js";
import { withDbSession } from "../db/session.js";
import { getGeneratedCrudTables } from "./entity/catalog.js";
import { createGeneratedEntityForTable } from "./entity/mutations.js";
import { listGeneratedEntitiesForTable } from "./entity/queries.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./entity/types.js";
import { createConstrainedReferenceInTransaction } from "./constrained-reference-create.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const suite = describe;
const scratchName = `constrained_reference_${randomUUID().replaceAll("-", "")}`;
const tenantId = randomUUID(), userId = randomUUID();
const allowedGroup = "10000000-0000-4000-8000-000000000099";
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined, created = false;
const column = (name: string, type: string, sourceField?: string): GeneratedCrudColumn => ({
  name, type, required: name !== "display_name", primaryKey: name === "id", generated: name === "id" ? "gen_random_uuid()" : null,
  ...(sourceField ? { sourceField } : {}),
});
const source = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "Relation")!;
const membershipSource = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "RelationGroupMembership")!;
const target: GeneratedCrudTable = {
  ...structuredClone(source),
  columns: [column("id", "uuid", "id"), column("tenant_id", "uuid", "tenantId"), column("display_name", "text", "displayName"), column("relation_type", "text", "relationType")],
  source: { ...structuredClone(source.source!), computedFields: [] },
};
const child: GeneratedCrudTable = {
  ...structuredClone(membershipSource),
  columns: [column("id", "uuid", "id"), column("tenant_id", "uuid", "tenantId"), column("relation_id", "uuid", "relationId"), column("relation_group_id", "uuid", "relationGroupId")],
  source: { ...structuredClone(membershipSource.source!), computedFields: [] },
};
const owner: GeneratedCrudTable = {
  ...structuredClone(source), table: "deals", name: "erp.deals",
  columns: [column("id", "uuid", "id"), column("tenant_id", "uuid", "tenantId"), column("relation_id", "uuid", "relationId")],
  source: {
    ...structuredClone(source.source!), authoringEntityName: "Deal", computedFields: [],
    graphql: { ...structuredClone(source.source!.graphql!), singleQueryName: "deal", relationships: [{
      name: "relation", fieldKey: "relationId", target: "Relation", type: "Relation", resolve: "belongsTo", foreignKey: "relation_id",
      constraints: { relationType: { eq: "organization" }, groupMemberships: { any: { relationGroupId: { eq: allowedGroup } } } },
    }] },
  },
};
const session = {
  tenantId, userId, scope: "self" as const,
  roles: [...new Set([
    ...(target.source!.authorization!.roles.read ?? []), ...(target.source!.authorization!.roles.create ?? []),
    ...(child.source!.authorization!.roles.read ?? []), ...(child.source!.authorization!.roles.create ?? []),
  ])],
};

function databaseUrl(app = false) {
  const url = new URL(adminUrl!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}

suite("atomic constrained reference creation against PostgreSQL", () => {
  beforeAll(async () => {
    databaseUrl(); admin = new SQL(adminUrl!, { max: 1 });
    const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
    if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) throw new Error("An existing restricted app role is required; shared roles are never changed.");
    await admin.unsafe(`create database "${scratchName}"`); created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
    await applyAppHelpersMigration(privileged.db);
    await sql.raw(`create schema erp; create schema platform;
      create table erp.relations(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, display_name text, relation_type text not null, unique(tenant_id,id));
      create table erp.relation_group_memberships(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, relation_id uuid not null, relation_group_id uuid not null,
        check(relation_group_id = '${allowedGroup}'::uuid), unique(tenant_id,id), foreign key(tenant_id,relation_id) references erp.relations(tenant_id,id));
      create table erp.deals(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, relation_id uuid not null,
        unique(tenant_id,id), foreign key(tenant_id,relation_id) references erp.relations(tenant_id,id));
      create table platform.entity_events(id uuid primary key default gen_random_uuid(), tenant_id uuid not null, aggregate_type text not null,
        aggregate_id text not null, event_type text not null, payload jsonb, sequence bigint generated always as identity, occurred_at timestamptz not null);
      alter table erp.relations enable row level security; alter table erp.relations force row level security;
      alter table erp.relation_group_memberships enable row level security; alter table erp.relation_group_memberships force row level security;
      alter table erp.deals enable row level security; alter table erp.deals force row level security;
      create policy tenant on erp.relations using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on erp.relation_group_memberships using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create policy tenant on erp.deals using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      grant usage on schema app,erp,platform to openshapeforge_app;
      grant select,insert,update,delete on all tables in schema erp,platform to openshapeforge_app;
      grant usage on all sequences in schema platform to openshapeforge_app;
      grant execute on all functions in schema app to openshapeforge_app`).execute(privileged.db);
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 2 });
  }, 30_000);
  afterAll(async () => {
    await restricted?.close(); await privileged?.close();
    if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`);
    await admin?.close();
  });
  test("commits both rows and rolls the target back when membership creation fails", async () => {
    const binding = {
      type: "constrained-reference-create" as const, targetEntityName: "Relation", collectionEntityName: "RelationGroupMembership", parentField: "relationId",
      targetValues: { relationType: "organization" }, childValues: { relationGroupId: allowedGroup },
    };
    await withDbSession(restricted!.db, session, trx => createConstrainedReferenceInTransaction(trx, session, binding, target, child, { displayName: "Allowed" }));
    expect((await sql<{ count: number }>`select count(*)::int as count from erp.relations`.execute(privileged!.db)).rows[0]!.count).toBe(1);
    expect((await sql<{ count: number }>`select count(*)::int as count from erp.relation_group_memberships`.execute(privileged!.db)).rows[0]!.count).toBe(1);
    await expect(withDbSession(restricted!.db, session, trx => createConstrainedReferenceInTransaction(trx, session, {
      ...binding, childValues: { relationGroupId: randomUUID() },
    }, target, child, { displayName: "Rolled back" }))).rejects.toThrow();
    expect((await sql<{ count: number }>`select count(*)::int as count from erp.relations`.execute(privileged!.db)).rows[0]!.count).toBe(1);
    expect((await sql<{ count: number }>`select count(*)::int as count from platform.entity_events`.execute(privileged!.db)).rows[0]!.count).toBe(2);

    await withDbSession(restricted!.db, session, trx => createConstrainedReferenceInTransaction(trx, session, {
      type: "constrained-reference-create", targetEntityName: "Relation", targetValues: { relationType: "organization" },
    }, target, undefined, { displayName: "Direct", relationType: "person" }));
    expect((await sql<{ relationType: string }>`select relation_type as "relationType" from erp.relations where display_name='Direct'`.execute(privileged!.db)).rows[0]!.relationType).toBe("organization");

    const selected = await listGeneratedEntitiesForTable(restricted!.db, session, target, { filter: {
      relationType: { eq: "organization" }, groupMemberships: { any: { relationGroupId: { eq: allowedGroup } } },
    } });
    expect(selected.rows).toHaveLength(1);
    const allowedId = (await sql<{ id: string }>`select id from erp.relations where display_name='Allowed'`.execute(privileged!.db)).rows[0]!.id;
    await createGeneratedEntityForTable(restricted!.db, session, owner, { relationId: allowedId });
    const ungroupedId = randomUUID();
    await sql`insert into erp.relations(id,tenant_id,display_name,relation_type) values (${ungroupedId}::uuid,${tenantId}::uuid,'Ungrouped','organization')`.execute(privileged!.db);
    await expect(createGeneratedEntityForTable(restricted!.db, session, owner, { relationId: ungroupedId }))
      .rejects.toMatchObject({ operationError: { code: "VALIDATION", violations: [{ field: "relationId", code: "RELATIONSHIP_CONSTRAINT" }] } });
  });
});
