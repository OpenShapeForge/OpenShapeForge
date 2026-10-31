// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { withDbSession } from "../../db/session.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { aggregateBoardGroupsForTable } from "./board-aggregate.js";
import { bindAuthorizationProfileAccess } from "../../auth/authorization-profile-decision.js";
import { withAuditContext } from "../../platform/audit-context.js";
import { listGeneratedEntitiesForTable } from "./queries.js";
import { generatedCrudTables } from "./table-registry.js";
import { entityOperationRef, executeEntityOperation } from "./runtime.js";
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
  await sql`create schema if not exists platform; create table platform.entity_edit_leases (id uuid, tenant_id uuid, entity_id text, target_id text, operation_id text, owner_user_id uuid, owner_display_name text, acquired_version text, inactivity_timeout_seconds integer, expires_at timestamptz); create table platform.field_value_since(tenant_id uuid,entity_type text,record_id text,field_key text,since_at timestamptz); alter table platform.field_value_since enable row level security; alter table platform.field_value_since force row level security; create policy tenant on platform.field_value_since using (tenant_id=app.current_tenant()); grant usage on schema platform to openshapeforge_app; grant select on platform.entity_edit_leases, platform.field_value_since to openshapeforge_app`.execute(privileged.db);
  await sql`grant usage on schema app, erp to openshapeforge_app; grant select, insert, update, delete on all tables in schema erp to openshapeforge_app; grant execute on all functions in schema app to openshapeforge_app`.execute(privileged.db);
  restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1 });
}, 30000);
afterAll(async () => { await restricted?.close(); await privileged?.close(); if (created) await admin?.unsafe(`drop database "${scratchName}" with (force)`); await admin?.close(); });

test("sum preserves decimals, scope, filters and separate currencies", async () => {
  const q1 = randomUUID(), q2 = randomUUID(), q3 = randomUUID(), qForeign = randomUUID(), qHidden = randomUUID(), qNoAmount = randomUUID(), qBadCurrency = randomUUID();
  for (const [id, owner, viewer, amount, currency] of [[q1,tenant,user,"999999999999999.01","EUR"],[q2,tenant,user,"0.02","EUR"],[q3,tenant,user,"7.25","USD"],[qForeign,foreignTenant,user,"400","EUR"],[qHidden,tenant,otherUser,"300","EUR"],[qNoAmount,tenant,user,null,"EUR"],[qBadCurrency,tenant,user,"1","eur"]]) {
    await sql`insert into erp.contact_details (id,tenant_id,viewer,amount,currency) values (${id}::uuid,${owner}::uuid,${viewer}::uuid,${amount}::numeric,${currency})`.execute(privileged!.db);
  }
  for (const [owner,viewer,stage,quote] of [[tenant,user,"open",q1],[tenant,user,"open",q2],[tenant,user,"open",q3],[foreignTenant,user,"open",qForeign],[tenant,otherUser,"open",qHidden],[tenant,user,"hidden",qHidden],[tenant,user,"missing",null],[tenant,user,"nullable",qNoAmount],[tenant,user,"invalid",qBadCurrency],[tenant,user,"mixed",q1],[tenant,user,"mixed",q3],[tenant,user,"mixed",qHidden]]) {
    await sql`insert into erp.relations (id,tenant_id,viewer,stage,quote_id) values (${randomUUID()}::uuid,${owner}::uuid,${viewer}::uuid,${stage},${quote}::uuid)`.execute(privileged!.db);
  }
  const result = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root,target], { filter: {} });
  expect(result.map(group => group.group)).toEqual(["hidden", "invalid", "missing", "mixed", "nullable", "open"]);
  const open = result.find(group => group.group === "open")!;
  expect(open.available).toBe(true);
  expect(open.totals.map(total => total.currency)).toEqual(["EUR", "USD"]);
  expect(open.totals).toContainEqual({ currency: "EUR", amount: "999999999999999.03" });
  expect(open.totals).toContainEqual({ currency: "USD", amount: "7.25" });
  expect(result.find(group => group.group === "hidden")).toEqual({ group: "hidden", available: false, totals: [] });
  expect(result.find(group => group.group === "missing")).toEqual({ group: "missing", available: false, totals: [] });
  expect(result.find(group => group.group === "nullable")).toEqual({ group: "nullable", available: false, totals: [] });
  expect(result.find(group => group.group === "invalid")).toEqual({ group: "invalid", available: false, totals: [] });
  expect(result.find(group => group.group === "mixed")).toEqual({ group: "mixed", available: false, totals: [] });
  // Route restriction and search/advanced terms share the canonical list filter.
  const filter = { and: [{ viewer: { eq: user } }, { stage: { eq: "open" } }, { stage: { contains: "pen" } }] };
  const list = await withAuditContext(`${root.source!.authoringEntityName}.list`, undefined, () => listGeneratedEntitiesForTable(restricted!.db, session, root, { filter, limit: 1, includeTotalCount: true }));
  expect(list.totalCount).toBe(3);
  expect(list.rows).toHaveLength(1);
  const filtered = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root,target], { filter });
  expect(filtered).toEqual([open]);
  const deniedTarget = { ...target, columns: target.columns.map(entry => entry.name === "amount" ? { ...entry, fieldPolicy: { readRoles: ["not-granted"] } } : entry) };
  await expect(aggregateBoardGroupsForTable(restricted!.db, session, root, [root, deniedTarget], {})).rejects.toThrow("Not authorized");
  const deniedForeign = { ...root, columns: root.columns.map(entry => entry.name === "quote_id" ? { ...entry, fieldPolicy: { readRoles: ["not-granted"] } } : entry) };
  await expect(aggregateBoardGroupsForTable(restricted!.db, session, deniedForeign, [deniedForeign, target], {})).rejects.toThrow("Not authorized");
  const deniedGroup = { ...root, columns: root.columns.map(entry => entry.name === "stage" ? { ...entry, fieldPolicy: { readRoles: ["not-granted"] } } : entry) };
  await expect(aggregateBoardGroupsForTable(restricted!.db, session, deniedGroup, [deniedGroup, target], {})).rejects.toThrow("Not authorized");
  const restrictedSession = { ...session };
  bindAuthorizationProfileAccess(restrictedSession, { managedEntities: [], operations: {}, listFields: { [target.source!.authoringEntityName!]: ["id", "currency"] } });
  await expect(aggregateBoardGroupsForTable(restricted!.db, restrictedSession, root, [root, target], {})).rejects.toThrow("outside the list projection");
  const listOnlySession = { ...session };
  bindAuthorizationProfileAccess(listOnlySession, { managedEntities: [target.source!.authoringEntityName!], operations: { [`${target.source!.authoringEntityName}.list`]: true, [`${target.source!.authoringEntityName}.get`]: false }, listFields: { [target.source!.authoringEntityName!]: ["id", "amount", "currency"] } });
  const listOnly = await aggregateBoardGroupsForTable(restricted!.db, listOnlySession, root, [root, target], { filter: { stage: { eq: "open" } } });
  expect(listOnly).toEqual([open]);
  const constrainedRoot = { ...root, source: { ...root.source!, graphql: { ...root.source!.graphql!, relationships: [{ ...root.source!.graphql!.relationships![0]!, constraints: { currency: { eq: "EUR" } } }] } } };
  await expect(aggregateBoardGroupsForTable(restricted!.db, session, constrainedRoot, [constrainedRoot, target], {})).rejects.toThrow("Invalid board aggregate relationship");
  const scopedTarget: GeneratedCrudTable = { ...target, subtype: { base: { entityName: "ContactDetail", entityId: "core.ContactDetail", slug: "contact-detail", table: target.name }, scope: [{ field: "currency", column: "currency", value: "EUR" }], hiddenColumns: [] } };
  const scoped = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root, scopedTarget], { filter: { stage: { eq: "open" } } });
  expect(scoped).toEqual([{ group: "open", available: false, totals: [] }]);
  const snapshot = await withDbSession(restricted!.db, session, async () => {
    const before = await withAuditContext(`${root.source!.authoringEntityName}.list`, undefined, () => listGeneratedEntitiesForTable(restricted!.db, session, root, { filter: { stage: { eq: "open" } }, includeTotalCount: true }));
    await sql`insert into erp.relations (id,tenant_id,viewer,stage,quote_id) values (${randomUUID()}::uuid,${tenant}::uuid,${user}::uuid,'open',${q2}::uuid)`.execute(privileged!.db);
    const totals = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root,target], { filter: { stage: { eq: "open" } } });
    return { before, totals };
  }, { isolationLevel: "repeatable read" });
  expect(snapshot.before.totalCount).toBe(3);
  expect(snapshot.totals).toEqual([open]);
  const after = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root,target], { filter: { stage: { eq: "open" } } });
  expect(after[0]!.totals).toContainEqual({ currency: "EUR", amount: "999999999999999.05" });
  const oldRoot = generatedCrudTables.get(root.name)!;
  const oldTarget = generatedCrudTables.get(target.name)!;
  generatedCrudTables.set(root.name, root);
  generatedCrudTables.set(target.name, target);
  try {
    const malformed = await executeEntityOperation(restricted!.db, session, { operation: entityOperationRef(root, "list"), input: { includeBoardTotals: "yes" as never } });
    expect("error" in malformed && malformed.error.code).toBe("BAD_USER_INPUT");
    let inserted = false;
    const interleaved = restricted!.db.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        // Interleave at the real list query boundary, before its totals query.
        if (!inserted && args.result.rows.some(row => {
          const data = (row as { row?: { stage?: string } }).row;
          return data?.stage === "open";
        })) {
          inserted = true;
          await sql`insert into erp.relations (id,tenant_id,viewer,stage,quote_id) values (${randomUUID()}::uuid,${tenant}::uuid,${user}::uuid,'open',${q2}::uuid)`.execute(privileged!.db);
        }
        return args.result;
      },
    });
    const envelope = await executeEntityOperation(interleaved, session, { operation: entityOperationRef(root, "list"), input: { filter: { stage: { eq: "open" } }, limit: 1, includeBoardTotals: true }, offerIntents: [] });
    expect(inserted).toBe(true);
    expect("error" in envelope ? envelope.error : envelope.intent === "list" ? envelope.data.boardTotals : undefined).toEqual(after);
    expect(!("error" in envelope) && envelope.intent === "list" ? envelope.data.items : undefined).toHaveLength(1);
    const latest = await aggregateBoardGroupsForTable(restricted!.db, session, root, [root,target], { filter: { stage: { eq: "open" } } });
    expect(latest[0]!.totals).toContainEqual({ currency: "EUR", amount: "999999999999999.07" });
  } finally {
    generatedCrudTables.set(root.name, oldRoot);
    generatedCrudTables.set(target.name, oldTarget);
  }
});

test("temporal result uses current target threshold and respects target row and field access", async () => {
  const record = randomUUID(), item = randomUUID(), hidden = randomUUID(), hiddenRecord = randomUUID(), noHistory = randomUUID();
  await sql`insert into erp.contact_details (id,tenant_id,viewer,amount,currency) values (${item}::uuid,${tenant}::uuid,${user}::uuid,2,'EUR'),(${hidden}::uuid,${tenant}::uuid,${otherUser}::uuid,2,'EUR')`.execute(privileged!.db);
  await sql`insert into erp.relations (id,tenant_id,viewer,stage,quote_id) values (${record}::uuid,${tenant}::uuid,${user}::uuid,'temporal',${item}::uuid),(${hiddenRecord}::uuid,${tenant}::uuid,${user}::uuid,'temporal',${hidden}::uuid),(${noHistory}::uuid,${tenant}::uuid,${user}::uuid,'temporal',${item}::uuid)`.execute(privileged!.db);
  await sql`insert into platform.field_value_since values (${tenant}::uuid,${root.source!.authoringEntityName},${record},'quoteId',now()-interval '3 days'),(${tenant}::uuid,${root.source!.authoringEntityName},${hiddenRecord},'quoteId',now()-interval '3 days')`.execute(privileged!.db);
  const temporalRoot: GeneratedCrudTable = { ...root, source: { ...root.source!, computedFields: [{ field: "stagnation", resolver: "temporalThreshold", trackedField: "quoteId", thresholdDays: "quoteId.amount" }] } };
  const oldRoot = generatedCrudTables.get(root.name)!, oldTarget = generatedCrudTables.get(target.name)!;
  generatedCrudTables.set(root.name, temporalRoot); generatedCrudTables.set(target.name, target);
  const read = () => withAuditContext(`${root.source!.authoringEntityName}.list`, undefined, () => listGeneratedEntitiesForTable(restricted!.db, session, temporalRoot, { filter: { stage: { eq: "temporal" } } }));
  try {
    let values = new Map((await read()).rows.map(row => [row.id, (row.stagnation as { status: string }).status]));
    expect(values.get(record)).toBe("exceeded");
    expect(values.get(hiddenRecord)).toBe("unknown");
    expect(values.get(noHistory)).toBe("unknown");
    const wire = await executeEntityOperation(restricted!.db, session, { operation: entityOperationRef(temporalRoot, "list"), input: { filter: { stage: { eq: "temporal" } } }, offerIntents: [] });
    expect(!("error" in wire) && wire.intent === "list" ? wire.data.items.find(entry => entry.data.id === record)?.data.stagnation : undefined).toMatchObject({ status: "exceeded" });
    await sql`update erp.contact_details set amount=4 where id=${item}::uuid`.execute(privileged!.db);
    values = new Map((await read()).rows.map(row => [row.id, (row.stagnation as { status: string }).status]));
    expect(values.get(record)).toBe("within");
    generatedCrudTables.set(target.name, { ...target, columns: target.columns.map(column => column.name === "amount" ? { ...column, fieldPolicy: { readRoles: ["not-granted"] } } : column) });
    values = new Map((await read()).rows.map(row => [row.id, (row.stagnation as { status: string }).status]));
    expect(values.get(record)).toBe("unknown");
  } finally {
    generatedCrudTables.set(root.name, oldRoot); generatedCrudTables.set(target.name, oldTarget);
  }
});
