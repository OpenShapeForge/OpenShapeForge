// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { registerOperationExecutionPolicies } from "../execution-policy.js";
import { completeEntitySecureInput, getEntityOperationContracts } from "./runtime.js";
import { getGeneratedCrudTables } from "./catalog.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const name = `security_${crypto.randomUUID().replaceAll("-", "")}`;
let admin: SQL, privileged: DatabaseRuntime, runtime: DatabaseRuntime;
const table = getGeneratedCrudTables().find(t => t.source?.authoringEntityName === "Task")!;
const operation = getEntityOperationContracts().find(o => o.id === "Task.create")!;
const title = table.columns.find(c => c.name === "title")!;
const oldPolicy = title.fieldPolicy;
const oldInteraction = operation.interaction;
const oldMcp = table.source!.mcp;
const actor = {tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: ["General.All.ReadWrite"], groups: [], oauthScopes: [], credential: 'bearer' as const, scope: "tenant" as const};
const values = { title: "Security test", type: "follow_up", status: "open" };
const completion = { into: "metadata", value: { label: "only the person supplied this" } };
const run = () => completeEntitySecureInput(runtime.db, actor, {operation: {id: operation.id, intent:"create"}, input:{values}}, completion);

beforeAll(async () => {
  const url = new URL(adminUrl);
  if (!['localhost','127.0.0.1'].includes(url.hostname) || url.pathname !== '/postgres') throw Error('Isolated local admin database required');
  admin = new SQL(adminUrl);
  await admin.unsafe(`create database "${name}"`);
  url.pathname = `/${name}`;
  privileged = createDatabaseRuntime({databaseUrl:url.href});
  await privileged.db.connection().execute(connection => runMigrationChain(connection));
  url.username='openshapeforge_app'; url.password='openshapeforge_app';
  runtime=createDatabaseRuntime({databaseUrl:url.href});
  const secure = {type:"secureInput" as const, sourceField:"parentTaskId", sourceEntity:"Task", definitionsField:"formDefinition", into:"metadata"};
  operation.interaction = {...oldInteraction, secureInput:secure};
  table.source!.mcp = {...oldMcp, elicitOnCreate:{...secure, sourceTable:table.name}} as NonNullable<typeof oldMcp>;
}, 180_000);

afterAll(async () => {
  if(oldPolicy) title.fieldPolicy=oldPolicy; else delete title.fieldPolicy; operation.interaction=oldInteraction; if(oldMcp) table.source!.mcp=oldMcp; else delete table.source!.mcp;
  delete operation.prerequisites;
  await runtime?.close(); await privileged?.close();
  await admin?.unsafe(`drop database if exists "${name}" with(force)`); await admin?.close();
});

test("secure completion refuses model fields denied by field write roles", async () => {
  title.fieldPolicy={writeRoles:['Security.Special.Write']};
  try { expect(await run()).toMatchObject({error:{code:'FORBIDDEN'}}); }
  finally { if(oldPolicy) title.fieldPolicy=oldPolicy; else delete title.fieldPolicy; }
});

test("secure completion repeats prerequisite admission", async () => {
  operation.prerequisites=[{operation:'Security.acknowledge', receipt:{binding:'loginSession'}}];
  try { expect(await run()).toMatchObject({error:{code:'PREREQUISITE_RECEIPT_UNAVAILABLE'}}); }
  finally { delete operation.prerequisites; }
});

test("host refusal blocks secure completion and leaves no stored row", async () => {
  let evaluations = 0;
  registerOperationExecutionPolicies(runtime.db,[{name:'security-policy', executionPolicies:[{
    name:'deny', evaluate:async()=>{ evaluations++; return {admitted:false, refusal:{message:'Security test refusal'}}; }
  }]}] as never);
  try { expect(await run()).toMatchObject({error:{code:'EXECUTION_NOT_PERMITTED'}}); }
  finally { registerOperationExecutionPolicies(runtime.db,[]); }
  expect(evaluations).toBe(1);
  const result=await sql<{n:number}>`select count(*)::int n from erp.tasks where tenant_id=${actor.tenantId}::uuid`.execute(privileged.db);
  expect(result.rows[0]!.n).toBe(0);
});

test("a create continuation cannot overwrite an existing configuration", async () => {
  const result = await completeEntitySecureInput(runtime.db, actor,
    {operation:{id:operation.id,intent:"create"},input:{values}}, {...completion,existingId:crypto.randomUUID()});
  expect(result).toMatchObject({error:{code:"FORBIDDEN"}});
});

test("a policy revoked at the final write rolls back secure completion", async () => {
  let evaluations = 0;
  registerOperationExecutionPolicies(runtime.db,[{name:"security-policy",executionPolicies:[{
    name:"revoke",evaluate:async()=>++evaluations===1 ? {admitted:true} : {admitted:false,refusal:{message:"Access revoked"}}
  }]}] as never);
  try { expect(await run()).toMatchObject({error:{code:"EXECUTION_NOT_PERMITTED"}}); }
  finally { registerOperationExecutionPolicies(runtime.db,[]); }
  expect(evaluations).toBeGreaterThan(1);
  const rows=await sql<{n:number}>`select count(*)::int n from erp.tasks where tenant_id=${actor.tenantId}::uuid`.execute(privileged.db);
  expect(rows.rows[0]!.n).toBe(0);
});

test("allowed completion stores the server-bound target and ordinary fields", async () => {
  const result=await run();
  if ('error' in result) throw Error(JSON.stringify(result.error));
  expect(result.intent).toBe('create');
  const stored=await sql<{title:string;metadata:unknown}>`select title,metadata from erp.tasks where tenant_id=${actor.tenantId}::uuid`.execute(privileged.db);
  expect(stored.rows).toEqual([{title:values.title,metadata:completion.value}]);
});


test("secure create retains server-owned Operation attribution", async () => {
  const stampColumn = table.columns.find(column => column.name === "external_id")!;
  const oldWriters = stampColumn.writtenBy;
  const oldStamps = operation.stamps;
  stampColumn.writtenBy = [{operation:operation.id,rest:"create"}];
  operation.stamps = [{field:"externalId",source:"actorUserId"}];
  try {
    const result = await run();
    if ("error" in result) throw Error(JSON.stringify(result.error));
    if (result.intent !== "create") throw Error("Expected create result");
    const row = await sql<{external_id:string}>`select external_id from erp.tasks where id=${String(result.data?.id)}::uuid`.execute(privileged.db);
    expect(row.rows[0]?.external_id).toBe(actor.userId);
  } finally {
    if(oldWriters) stampColumn.writtenBy=oldWriters; else delete stampColumn.writtenBy;
    if(oldStamps) operation.stamps=oldStamps; else delete operation.stamps;
  }
});

test("secure completion attributes only verified principal kinds in tenant audit events", async () => {
  for (const [principalKind, expected] of [["person", "person"], [undefined, "unknown"]] as const) {
    const session = {...actor, tenantId: crypto.randomUUID(), ...(principalKind ? {principalKind} : {})};
    const result = await completeEntitySecureInput(runtime.db, session,
      {operation:{id:operation.id,intent:"create"},input:{values}}, completion);
    if ("error" in result) throw Error(JSON.stringify(result.error));
    if (result.intent !== "create") throw Error("Expected create result");
    const events = await sql<{tenant_id:string; actor_kind:string}>`
      select tenant_id::text, payload->'audit'->>'actorKind' as actor_kind
      from platform.entity_events
      where aggregate_id=${String(result.data?.id)} and tenant_id=${session.tenantId}::uuid
    `.execute(privileged.db);
    expect(events.rows).toEqual([{tenant_id:session.tenantId, actor_kind:expected}]);
  }
});
