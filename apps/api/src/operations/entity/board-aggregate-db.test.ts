// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { aggregateBoardGroupsForTable } from "./board-aggregate.js";
import { bindAuthorizationProfileAccess } from "../../auth/authorization-profile-decision.js";
import type { GeneratedCrudTable } from "./types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `board_aggregate_${randomUUID().replaceAll("-", "")}`;
const tenant = randomUUID(), foreignTenant = randomUUID(), user = randomUUID(), otherUser = randomUUID();
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined, created = false;
const rootBase = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "Relation")!;
const targetBase = getGeneratedCrudTables().find(table => table.source?.authoringEntityName === "ContactDetail")!;
const column = (name: string, type: string, sourceField?: string) => ({ name, type, primaryKey: name === "id", required: false, generated: null, ...(sourceField ? { sourceField } : {}) });
const root: GeneratedCrudTable = { ...rootBase, columns: [column("id", "uuid"), column("tenant_id", "uuid"), column("viewer", "uuid"), column("stage", "text"), column("quote_id", "uuid", "quoteId")], source: { ...rootBase.source, computedFields: [], boardAggregate: { groupBy: "stage", sum: "quoteId.amount", currency: "quoteId.currency" }, graphql: { ...rootBase.source!.graphql!, relationships: [{ name: "quoteId", fieldKey: "quoteId", kind: "belongsTo", resolve: "belongsTo", target: targetBase.source!.graphql!.typeName, type: "ContactDetail", foreignKey: "quote_id" }] } } };
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
  await sql`grant usage on schema app, erp to openshapeforge_app; grant select, insert, update, delete on all tables in schema erp to openshapeforge_app; grant execute on all functions in schema app to openshapeforge_app`.execute(privileged.db);
  restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1 });
}, 30000);
afterAll(async () => { await restricted?.close(); await privileged?.close(); if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`); await admin?.close(); });

test("sum preserves decimals, scope, filters and separate currencies", async () => {
  const q1 = randomUUID(), q2 = randomUUID(), q3 = randomUUID(), qForeign = randomUUID(), qHidden = randomUUID();
  for (const [id, owner, viewer, amount, currency] of [[q1,tenant,user,"999999999999999.01","EUR"],[q2,tenant,user,"0.02","EUR"],[q3,tenant,user,"7.25","USD"],[qForeign,foreignTenant,user,"400","EUR"],[qHidden,tenant,otherUser,"300","EUR"]]) {
    await sql`insert into erp.contact_details (id,tenant_id,viewer,amount,currency) values (${id}::uuid,${owner}::uuid,${viewer}::uuid,${amount}::numeric,${currency})`.execute(privileged!.db);
  }
  for (const [owner,viewer,stage,quote] of [[tenant,user,"open",q1],[tenant,user,"open",q2],[tenant,user,"open",q3],[foreignTenant,user,"open",qForeign],[tenant,otherUser,"open",qHidden],[tenant,user,"hidden",qHidden],[tenant,user,"missing",null],[tenant,user,"mixed",q1],[tenant,user,"mixed",q3],[tenant,user,"mixed",qHidden]]) {
    await sql`insert into erp.relations (id,tenant_id,viewer,stage,quote_id) values (${randomUUID()}::uuid,${owner}::uuid,${viewer}::uuid,${stage},${quote}::uuid)`.execute(privileged!.db);
  }
  const result = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root,target], { filter: {} });
  const open = result.find(group => group.group === "open")!;
  expect(open.available).toBe(true);
  expect(open.totals).toContainEqual({ currency: "EUR", amount: "999999999999999.03" });
  expect(open.totals).toContainEqual({ currency: "USD", amount: "7.25" });
  expect(result.find(group => group.group === "hidden")).toEqual({ group: "hidden", available: false, totals: [] });
  expect(result.find(group => group.group === "missing")).toEqual({ group: "missing", available: false, totals: [] });
  expect(result.find(group => group.group === "mixed")).toEqual({ group: "mixed", available: false, totals: [] });
  const filtered = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root,target], { filter: { stage: { eq: "open" } } });
  expect(filtered).toEqual([open]);
  const deniedTarget = { ...target, columns: target.columns.map(entry => entry.name === "amount" ? { ...entry, fieldPolicy: { readRoles: ["not-granted"] } } : entry) };
  await expect(aggregateBoardGroupsForTable(restricted!.db, session, root, [root, deniedTarget], {})).rejects.toThrow("Not authorized");
  const restrictedSession = { ...session };
  bindAuthorizationProfileAccess(restrictedSession, { managedEntities: [], operations: {}, listFields: { [target.source!.authoringEntityName!]: ["id", "currency"] } });
  await expect(aggregateBoardGroupsForTable(restricted!.db, restrictedSession, root, [root, target], {})).rejects.toThrow("outside the list projection");
  const constrainedRoot = { ...root, source: { ...root.source!, graphql: { ...root.source!.graphql!, relationships: [{ ...root.source!.graphql!.relationships![0]!, constraints: { currency: { eq: "EUR" } } }] } } };
  await expect(aggregateBoardGroupsForTable(restricted!.db, session, constrainedRoot, [constrainedRoot, target], {})).rejects.toThrow("Invalid board aggregate relationship");
});
