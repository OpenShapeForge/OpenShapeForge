// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { withDbSession } from "../../db/session.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { readCollectionGroups } from "./collection-groups.js";
import { bindAuthorizationProfileAccess } from "../../auth/authorization-profile-decision.js";
import { withAuditContext } from "../../platform/audit-context.js";
import { listGeneratedEntitiesForTable } from "./queries.js";
import { generatedCrudTables } from "./table-registry.js";
import { entityOperationRef, executeEntityOperation } from "./runtime.js";
import type { GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `collection_groups_${randomUUID().replaceAll("-", "")}`;
const tenant = randomUUID(), foreignTenant = randomUUID(), user = randomUUID(), otherUser = randomUUID();
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined, created = false;
const rootBase = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "Relation")!;
const targetBase = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "ContactDetail")!;
const column = (name: string, type: string, sourceField?: string) => ({ name, type, primaryKey: name === "id", required: false, generated: null, ...(sourceField ? { sourceField } : {}) });
const root: GeneratedCrudTable = { ...rootBase, columns: [column("id", "uuid"), column("tenant_id", "uuid"), column("viewer", "uuid"), column("stage", "text"), column("quote_id", "uuid", "quoteId")], source: { ...rootBase.source, computedFields: [], collectionGroupBy: "stage", boardAggregate: { groupBy: "stage", sum: "quoteId.amount", currency: "quoteId.currency" }, graphql: { ...rootBase.source!.graphql!, relationships: [{ name: "quoteId", fieldKey: "quoteId", kind: "belongsTo", resolve: "belongsTo", target: targetBase.source!.graphql!.typeName, type: "ContactDetail", foreignKey: "quote_id" }] } } };
const target: GeneratedCrudTable = { ...targetBase, columns: [column("id", "uuid"), column("tenant_id", "uuid"), column("viewer", "uuid"), column("amount", "numeric"), column("currency", "text")], source: { ...targetBase.source, computedFields: [], graphql: { ...targetBase.source!.graphql!, relationships: [] } } };
const session = { tenantId: tenant, userId: user, roles: [...new Set([...(rootBase.source?.authorization?.roles.read ?? []), ...(targetBase.source?.authorization?.roles.read ?? [])])], scope: "self" as const };
function databaseUrl(app = false) {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}
beforeAll(async () => {
  databaseUrl(); admin = new SQL(adminUrl, { max: 1 });
  const roles = await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'openshapeforge_app'`;
  if (roles.length !== 1 || roles[0].rolsuper || roles[0].rolbypassrls) throw new Error("A restricted application role is required.");
  await admin.unsafe(`create database "${scratchName}"`); created = true;
  privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
  await applyAppHelpersMigration(privileged.db);
  const generatorPath = new URL("../../../../../packages/compiler/src/generate.ts", import.meta.url).pathname;
  const { generateArtifacts } = await import(generatorPath);
  const storage = (table: GeneratedCrudTable) => ({ schema: table.schema, name: table.table, tenantScoped: true, columns: table.columns.map(({ generated: _generated, ...entry }) => entry), rowScope: { userColumns: ["viewer"], nullVisibleColumns: ["viewer"] }, indexes: [{ name: `${table.table}_tenant_id_key`, columns: ["tenant_id", "id"], unique: true }] });
  const artifacts = generateArtifacts({ version: 1, tables: [storage(root), storage(target)] });
  await sql.raw(artifacts.find((entry: { path: string }) => entry.path.endsWith("schema.sql"))!.contents).execute(privileged.db);
  await sql`create schema if not exists platform; create table platform.entity_edit_leases (id uuid, tenant_id uuid, entity_id text, target_id text, operation_id text, owner_user_id uuid, owner_display_name text, acquired_version text, inactivity_timeout_seconds integer, expires_at timestamptz); create table platform.field_value_since(tenant_id uuid,entity_type text,record_id text,field_key text,since_at timestamptz); alter table platform.field_value_since enable row level security; alter table platform.field_value_since force row level security; create policy tenant on platform.field_value_since using (tenant_id=app.current_tenant()); grant usage on schema platform to openshapeforge_app; grant select on platform.entity_edit_leases, platform.field_value_since to openshapeforge_app`.execute(privileged.db);
  await sql`grant usage on schema app, erp to openshapeforge_app; grant select, insert, update, delete on all tables in schema erp to openshapeforge_app; grant execute on all functions in schema app to openshapeforge_app`.execute(privileged.db);
  restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1 });
}, 30000);
afterAll(async () => { await restricted?.close(); await privileged?.close(); if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`); await admin?.close(); });

test("groups cover more than one page and retain row, tenant and filter boundaries", async () => {
  const previous = generatedCrudTables.get(root.name); generatedCrudTables.set(root.name, root);
  try {
    await sql`insert into erp.relations(id,tenant_id,viewer,stage) select gen_random_uuid(),${tenant}::uuid,${user}::uuid,'A' from generate_series(1,1500)`.execute(privileged!.db);
    for (const [owner,viewer,stage] of [[tenant,user,'B'],[tenant,otherUser,'hidden'],[foreignTenant,user,'foreign']]) await sql`insert into erp.relations(id,tenant_id,viewer,stage) values(gen_random_uuid(),${owner}::uuid,${viewer}::uuid,${stage})`.execute(privileged!.db);
    const groups = await readCollectionGroups(restricted!.db, session, root.name);
    expect(groups).toEqual([{value:'A',count:1500},{value:'B',count:1}]);
    const page = await executeEntityOperation(restricted!.db, session, { operation: entityOperationRef(root, 'list'), input: { limit:1, includeCollectionGroups:true }, offerIntents:[] });
    expect('error' in page ? page.error : page.intent==='list' ? page.data.collectionGroups : undefined).toEqual(groups);
    expect(!('error' in page) && page.intent==='list' ? page.data.items : []).toHaveLength(1);
    expect(await readCollectionGroups(restricted!.db, session, root.name,{stage:{eq:'B'}})).toEqual([{value:'B',count:1}]);
    await expect(readCollectionGroups(restricted!.db,{...session,roles:[]},root.name)).rejects.toThrow();
    const classified = {...root,columns:root.columns.map(column=>column.name==='stage'?{...column,classification:'pii'}:column)} as GeneratedCrudTable;
    generatedCrudTables.set(root.name,classified);
    await expect(readCollectionGroups(restricted!.db,{...session,roles:rootBase.source!.authorization!.roles.read.filter(role=>role.endsWith(".Read"))},root.name)).rejects.toThrow();
  } finally { if(previous)generatedCrudTables.set(root.name,previous);else generatedCrudTables.delete(root.name); }
});
