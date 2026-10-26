// SPDX-License-Identifier: BUSL-1.1
import {afterAll,beforeAll,expect,test} from "bun:test";
import {randomUUID} from "node:crypto";
import {sql} from "kysely";
import {createDatabaseRuntime,readMigrateDatabaseUrl} from "../../db/connection.js";
import {withDbSession,currentDbSessionDatabase} from "../../db/session.js";
import {jsonbLiteral} from "../../db/sql-helpers.js";
import {getGeneratedCrudTables} from "../../operations/entity/catalog.js";
import {invokeTool} from "../entity-tool-invocation.js";
import {guardModelTypedValueArguments,withGuardedModelTypedValueWrite} from "../typed-value-write-guard.js";
import type {CatalogTool} from "../catalog.js";
import type {GeneratedCrudColumn} from "../../operations/entity/types.js";

// A disposable schema in the test database, never an existing setting row.
const schema=`mcp_typed_${randomUUID().replaceAll("-","")}`;
const db=createDatabaseRuntime();
const admin=createDatabaseRuntime({databaseUrl:readMigrateDatabaseUrl()});
const original=getGeneratedCrudTables().find(t=>t.source?.authoringEntityName==="Task")!;
const column=(name:string,extra:Partial<GeneratedCrudColumn>={}):GeneratedCrudColumn=>({name,sourceField:name,type:"jsonb",required:false,primaryKey:false,generated:null,...extra});
// Reuse an existing canonical role map, adding deferred columns only to this
// transport fixture. No generated entity or pre-existing row is modified.
// Denials reach invokeTool; the positive transaction/lock test uses a callback
// because canonical writes resolve the original table by its registry name.
const table={...original,schema,table:"settings",columns:[column("id",{type:"uuid",primaryKey:true}),column("tenant_id",{type:"uuid"}),column("definition"),column("value",{typedBy:{definitionField:"definition",definitionColumn:"definition",encrypted:true}})],source:{...original.source,crud:{operations:{list:false,get:false,create:true,update:true,delete:false}}}};
const actor={tenantId:randomUUID(),userId:randomUUID(),roles:["General.All.ReadWrite"]};
const foreign={...actor,tenantId:randomUUID(),userId:randomUUID()};
const id=randomUUID(),foreignId=randomUUID(),secretId=randomUUID();
const plain={key:"value",osfType:"string"};
const secret={...plain,classification:{sensitivity:"confidential"}};
beforeAll(async()=>{
  await sql`create schema ${sql.id(schema)}`.execute(admin.db);
  await sql`create table ${sql.id(schema,"settings")} (id uuid primary key,tenant_id uuid not null,definition jsonb,value jsonb)`.execute(admin.db);
  await sql`alter table ${sql.id(schema,"settings")} enable row level security`.execute(admin.db);
  await sql`alter table ${sql.id(schema,"settings")} force row level security`.execute(admin.db);
  await sql`create policy tenant on ${sql.id(schema,"settings")} using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid)`.execute(admin.db);
  await sql`grant usage on schema ${sql.id(schema)} to openshapeforge_app`.execute(admin.db);
  await sql`grant select,update on ${sql.id(schema,"settings")} to openshapeforge_app`.execute(admin.db);
  for(const [row,tenant] of [[id,actor.tenantId],[foreignId,foreign.tenantId]])await sql`insert into ${sql.id(schema,"settings")} values (${row}::uuid,${tenant}::uuid,${jsonbLiteral(plain)},'"initial"'::jsonb)`.execute(admin.db);
  await sql`insert into ${sql.id(schema,"settings")} values (${secretId}::uuid,${actor.tenantId}::uuid,${jsonbLiteral(secret)},null)`.execute(admin.db);
});
afterAll(async()=>{
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin.db);
  await db.close();await admin.close();
});

test("actual MCP create/update invocation refuses confidential model values before writing",async()=>{
  const tables=new Map([[table.name,table]]);
  const create={operation:"create",operationId:"Task.create",inputSchema:{type:"object",properties:{definition:{},value:{}}}} as unknown as CatalogTool;
  await expect(invokeTool(create,undefined,table,tables,db.db,actor,{definition:secret,value:"synthetic-only"})).rejects.toMatchObject({code:"SECURE_INPUT_REQUIRED"});
  const update={operation:"update",operationId:"Task.update",inputSchema:{type:"object",properties:{id:{},values:{type:"object",properties:{definition:{},value:{}}}}}} as unknown as CatalogTool;
  await expect(invokeTool(update,undefined,table,tables,db.db,actor,{id,values:{definition:secret,value:"synthetic-only"}})).rejects.toMatchObject({code:"SECURE_INPUT_REQUIRED"});
  await expect(invokeTool(update,undefined,table,tables,db.db,actor,{id:secretId,values:{value:"synthetic-only"}})).rejects.toMatchObject({code:"SECURE_INPUT_REQUIRED"});
  await expect(invokeTool(update,undefined,table,tables,db.db,actor,{id:foreignId,values:{value:"other tenant"}})).rejects.toMatchObject({status:404});
  await expect(invokeTool(update,undefined,table,tables,db.db,{...actor,roles:[]},{id,values:{value:"denied"}})).rejects.toMatchObject({operationError:{code:"FORBIDDEN"}});
  const row=(await sql<{value:unknown}>`select value from ${sql.id(schema,"settings")} where id=${id}::uuid`.execute(admin.db)).rows[0]!;
  expect(row.value).toBe("initial");
});

test("an update-only entity can write plain values; tenant/missing rows remain unavailable",async()=>{
  await expect(guardModelTypedValueArguments(db.db,actor,table,{value:"plain"},foreignId)).rejects.toMatchObject({status:404});
  await expect(guardModelTypedValueArguments(db.db,actor,table,{value:"plain"},randomUUID())).rejects.toMatchObject({status:404});
  await withGuardedModelTypedValueWrite(db.db,actor,table,{value:"plain"},id,async()=>{
    expect(Object.is(currentDbSessionDatabase(),db.db)).toBe(true);
    await withDbSession(db.db,actor,async trx=>{
      await sql`update ${sql.id(schema,"settings")} set value='"plain"'::jsonb where id=${id}::uuid`.execute(trx);
    });
    // A concurrent definition change cannot pass between guard and write.
    await expect(admin.db.transaction().execute(async trx=>{
      await sql`set local lock_timeout='50ms'`.execute(trx);
      await sql`update ${sql.id(schema,"settings")} set definition=${jsonbLiteral(secret)} where id=${id}::uuid`.execute(trx);
    })).rejects.toThrow("lock timeout");
  });
  const row=(await sql<{value:unknown;definition:unknown}>`select value,definition from ${sql.id(schema,"settings")} where id=${id}::uuid`.execute(admin.db)).rows[0]!;
  expect(row).toEqual({value:"plain",definition:plain});
});
