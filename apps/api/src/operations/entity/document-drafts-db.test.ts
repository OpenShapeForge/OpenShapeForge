// SPDX-License-Identifier: BUSL-1.1
import {test,expect} from 'bun:test';
import {SQL} from 'bun';
import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {createDatabaseRuntime,type DatabaseRuntime} from '../../db/connection.js';
import {runMigrationChain} from '../../db/migration-chain.js';
import {getGeneratedCrudTables} from './catalog.js';
import type {GeneratedCrudColumn} from './types.js';
import {jsonbLiteral} from '../../db/sql-helpers.js';
import {ModulePlatformRuntime,withModuleOperationSession} from '../../modules/platform.js';
import {listOperationContracts,runtimeStaticOperationRegistrations} from '../runtime.js';
test('a typed parent saves Document blocks atomically through canonical Operations and rejects stale or denied writes',async()=>{
 const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const url=new URL(adminUrl);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/postgres')throw Error('A scratch admin endpoint is required');
 const table=getGeneratedCrudTables().find(table=>table.source?.authoringEntityName==='Chip')!;
 const originalColumns=table.columns;
 const valueColumn=table.columns.find(column=>column.name==='value')!;const originalBinding=valueColumn.typedBy;const originalRequired=valueColumn.required;
 const name='document_draft_'+randomUUID().replaceAll('-','');const admin=new SQL(adminUrl,{max:1});let privileged:DatabaseRuntime|undefined,restricted:DatabaseRuntime|undefined;
 try{
  await admin.unsafe(`create database "${name}"`);url.pathname='/'+name;privileged=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:1});await privileged.db.connection().execute(runMigrationChain);
  url.username='openshapeforge_app';url.password='openshapeforge_app';restricted=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:2});const db=privileged.db;
  const tenant=randomUUID(),document=randomUUID(),setting=randomUUID();const variants=[randomUUID(),randomUUID()],blocks=[randomUUID(),randomUUID()];
  await sql`insert into platform.tenants(id,slug,name,status) values(${tenant}::uuid,${tenant},'Draft fixture','active')`.execute(db);
  await sql`insert into erp.tenants(id,tenant_id,slug,name,tenant_kind) values(${tenant}::uuid,${tenant}::uuid,${tenant},'Draft fixture','customer')`.execute(db);
  await sql`insert into erp.document_types(tenant_id,code,name) values(${tenant}::uuid,'note','Note')`.execute(db);
  await sql`insert into erp.documents(id,tenant_id,title,document_type,status) values(${document}::uuid,${tenant}::uuid,'Draft fixture','note','draft')`.execute(db);
  for(let index=0;index<2;index++){
   await sql`insert into erp.document_variants(id,tenant_id,document_id,channel,locale) values(${variants[index]}::uuid,${tenant}::uuid,${document}::uuid,'document',${index?'en':'nl'})`.execute(db);
   await sql`insert into erp.blocks(id,tenant_id,document_variant_id,document_variant_id_position,definition_key,definition_version,values) values(${blocks[index]}::uuid,${tenant}::uuid,${variants[index]}::uuid,0,'TextBlock',1,${jsonbLiteral({markdown:'before-'+index})})`.execute(db);
  }
  // The standalone fixture does not expose TenantSetting CRUD. Opt Chip's real
  // typed field into the same compiled carrier contract to exercise the engine.
  await sql`alter table erp.chips add column document_value_id uuid,alter column value drop not null`.execute(db);
  valueColumn.required=false;
  valueColumn.typedBy={...originalBinding!,documentField:'documentValue',documentColumn:'document_value_id'};
  table.columns=[...table.columns,{name:'document_value_id',type:'uuid',sourceField:'documentValue',required:false,primaryKey:false,generated:null} as GeneratedCrudColumn];
  await sql`insert into erp.chips(id,tenant_id,key,name,definition,document_value_id) values(${setting}::uuid,${tenant}::uuid,'context','Draft fixture',${jsonbLiteral({key:'value',osfType:'Document',document:{content:'blocks'}})},${document}::uuid)`.execute(db);
  const runtime=new ModulePlatformRuntime(restricted.db);
  runtime.registerStaticOperations(runtimeStaticOperationRegistrations([],{db:restricted.db,platform:runtime.services},listOperationContracts().filter(operation=>operation.implementation?.type==='collection'&&operation.implementation.entityName==='DocumentVariant')));
  const editor={tenantId:tenant,userId:randomUUID(),roles:['Organization.All.ReadWrite','CaseFile.All.ReadWrite','General.All.ReadWrite','Templates.Manage'],groups:[],scope:'tenant' as const,credential:'trusted-context' as const};
  const execute=(id:string,intent:'get'|'update',input:Record<string,unknown>,session=editor)=>withModuleOperationSession(runtime.services,session,active=>runtime.services.operations.execute(active!,{operation:{id,intent},input}));
  const read=async(id:string,entity='Chip')=>{const result=await execute(entity+'.get','get',{id});if('error'in result)throw Error(result.error.code);return result.data as Record<string,unknown>;};
  const draft=async(prefix:string)=>({documentId:document,variants:await Promise.all(variants.map(async(id,index)=>({id,expectedVersion:String((await read(id,'DocumentVariant')).updatedAt),blocks:[{id:blocks[index],definitionKey:'TextBlock',values:{markdown:prefix+index}}]})))});
  const before=await read(setting),first=await draft('saved-');
  const saved=await execute('Chip.update','update',{id:setting,expectedVersion:before.updatedAt,values:{value:first}});expect('error'in saved? saved.error:undefined).toBeUndefined();
  expect((await read(setting)).value).toBe(document);
  const stored=async()=> (await sql<{id:string;values:{markdown:string}}>`select id::text,values from erp.blocks where tenant_id=${tenant}::uuid order by document_variant_id`.execute(db)).rows;
  expect((await stored()).map(row=>row.values.markdown).sort()).toEqual(['saved-0','saved-1']);
  const current=await read(setting);
  const stale=await execute('Chip.update','update',{id:setting,expectedVersion:current.updatedAt,values:{value:first}});expect('error'in stale&&stale.error.code).toBe('VERSION_CONFLICT');
  const late=await draft('must-rollback-');late.variants[1]!.blocks[0]!.id=randomUUID();
  const refused=await execute('Chip.update','update',{id:setting,expectedVersion:current.updatedAt,values:{value:late,name:'must roll back'}});expect('error'in refused).toBe(true);
  expect((await stored()).map(row=>row.values.markdown).sort()).toEqual(['saved-0','saved-1']);expect((await read(setting)).name).not.toBe('must roll back');
  const denied=await execute('Chip.update','update',{id:setting,expectedVersion:current.updatedAt,values:{value:await draft('denied-')}},{...editor,roles:['CaseFile.All.Read']});expect('error'in denied&&denied.error.code).toBe('FORBIDDEN');
 }finally{valueColumn.required=originalRequired;valueColumn.typedBy=originalBinding;table.columns=originalColumns;await restricted?.close();await privileged?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close();}
},90000);
