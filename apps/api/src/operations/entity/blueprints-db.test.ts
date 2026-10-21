// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {SQL} from 'bun';
import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {createDatabaseRuntime} from '../../db/connection.js';
import {runMigrationChain} from '../../db/migration-chain.js';
import {blueprintOperationHandler,createFromBlueprint} from './blueprints.js';
import {executeEntityOperation} from './runtime.js';
import {getGeneratedCrudTables} from './catalog.js';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCHsAAAAASUVORK5CYII=';
const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';

test('publish handlers persist presentation, retire new choices, preserve copy provenance and restore availability',async()=>{
 const url=new URL(adminUrl);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/postgres')throw Error('An isolated local postgres admin database is required');
 const admin=new SQL(adminUrl,{max:1});
 const database=`blueprint_handlers_${randomUUID().replaceAll('-','')}`;
 await admin.unsafe(`create database "${database}"`);url.pathname=`/${database}`;
 const privileged=createDatabaseRuntime({databaseUrl:url.toString()});
 url.username='openshapeforge_app';url.password='openshapeforge_app';
 const runtime=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:2});
 try{
  await privileged.db.connection().execute(connection=>runMigrationChain(connection));
  const publisherId=randomUUID(),customerId=randomUUID(),strangerId=randomUUID();
  for(const [id,kind] of [[publisherId,'blueprint'],[customerId,'customer'],[strangerId,'customer']] as const){
   await sql`insert into platform.tenants(id,slug,name,status) values(${id}::uuid,${id},'Proof','active')`.execute(privileged.db);
   await sql`insert into erp.tenants(id,tenant_id,slug,name,tenant_kind) values(${id}::uuid,${id}::uuid,${id},'Proof',${kind})`.execute(privileged.db);
  }
  await sql`insert into platform.blueprint_libraries values(${customerId}::uuid,${publisherId}::uuid)`.execute(privileged.db);
  const publisher={tenantId:publisherId,userId:randomUUID(),roles:['Relations.All.Read','Relations.RelationGroups.ReadWrite','platform-operator'],groups:[],scope:'tenant' as const};
  const customer={...publisher,tenantId:customerId,userId:randomUUID(),roles:['Relations.All.Read','Relations.RelationGroups.ReadWrite']};
  const stranger={...customer,tenantId:strangerId};
  const created=await executeEntityOperation(runtime.db,publisher,{operation:{id:'RelationGroup.create',intent:'create'},input:{values:{externalId:'published-proof',name:'Published name',description:'Published description',groupType:'general'}}});
  if('error'in created||created.intent!=='create'||!created.data)throw Error(JSON.stringify(created));
  const root=created.data;
  const invoke=async(action:string,input:Record<string,unknown>,session=publisher)=>{
   const result=await blueprintOperationHandler(`RelationGroup.${action}`)(input,{db:runtime.db,session} as never);
   if(!('value'in result))throw Error(JSON.stringify(result));
   return result.value as any;
  };
  const publish=(values:Record<string,unknown>)=>invoke('publish',{id:root.id,...values});
  const list=()=>invoke('list',{},customer);
  await publish({thumbnail:png});
  expect((await list()).items[0]).toMatchObject({blueprintId:'published-proof',label:'Published name',description:'Published description',thumbnail:png,version:1});
  const table=getGeneratedCrudTables().find(row=>row.source?.authoringEntityName==='RelationGroup')!;
  const copy=await createFromBlueprint(runtime.db,customer,table,'published-proof',{});
  await publish({});expect((await list()).items[0].thumbnail).toBe(png);
  await expect(publish({thumbnail:'data:image/svg+xml;base64,PHN2Zz4='})).rejects.toThrow('bounded');
  await publish({retired:true});expect((await list()).items).toEqual([]);
  await expect(createFromBlueprint(runtime.db,customer,table,'published-proof',{})).rejects.toThrow('unavailable');
  const state=await invoke('status',{id:copy.id},customer);
  expect(state).toMatchObject({source:{blueprintId:'published-proof',version:1,latestVersion:3,label:'Published name'},updateAvailable:false});
  await expect(invoke('reset',{id:copy.id,blueprintVersion:3},customer)).rejects.toThrow('retired');
  expect((await invoke('list',{},stranger)).items).toEqual([]);
  await expect(invoke('status',{id:copy.id},stranger)).rejects.toThrow('Record not found');
  const snapshot=(await sql<{values_json:any}>`select values_json from platform.blueprint_versions where tenant_id=${publisherId}::uuid and version=3`.execute(privileged.db)).rows[0]!;
  expect(snapshot.values_json.$presentation).toEqual({thumbnail:png,retired:true});
  await publish({thumbnail:null,retired:false});
  expect((await list()).items[0]).toMatchObject({blueprintId:'published-proof',version:4});
  expect((await list()).items[0].thumbnail).toBeUndefined();
  expect((await invoke('status',{id:copy.id},customer)).source.version).toBe(1);
  const second=await createFromBlueprint(runtime.db,customer,table,'published-proof',{});
  expect(second.id).not.toBe(copy.id);
 }finally{
  await runtime.close();await privileged.close();await admin.unsafe(`drop database "${database}" with (force)`);await admin.close();
 }
},180_000);
