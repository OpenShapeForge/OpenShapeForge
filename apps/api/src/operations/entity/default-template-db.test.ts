import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {SQL} from 'bun';
import {sql} from 'kysely';
import {createDatabaseRuntime} from '../../db/connection.js';
import {withDbSession} from '../../db/session.js';
import {getGeneratedCrudTables} from './catalog.js';
import {applyDefaultTemplates} from './default-template.js';
import type {GeneratedCrudTable} from './types.js';
test('related defaults enforce tenant, read roles and field projection, and preserve explicit names',async()=>{
 const url=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const location=new URL(url);if(!['localhost','127.0.0.1'].includes(location.hostname)||location.pathname!='/postgres')throw new Error('Local scratch database only.');
 const database=`default_template_${randomUUID().replaceAll('-','')}`;const admin=new SQL(url,{max:1});await admin.unsafe(`create database "${database}"`);location.pathname=`/${database}`;
 const runtime=createDatabaseRuntime({databaseUrl:location.toString()});
 const tenantId=randomUUID(), id=randomUUID();
 try{
  await sql`create schema demo`.execute(runtime.db);await sql`create table demo.years(id uuid primary key,tenant_id uuid,code text)`.execute(runtime.db);await sql`insert into demo.years values (${id}::uuid,${tenantId}::uuid,'2027')`.execute(runtime.db);
  const actual=getGeneratedCrudTables().find(t=>t.source?.authoringEntityName==='FiscalYear')!;
  const year={...actual,schema:'demo',table:'years',primaryKey:'id',columns:[{name:'id',sourceField:'id',type:'uuid',required:true,primaryKey:true,generated:null},{name:'code',sourceField:'code',type:'text',required:true,primaryKey:false,generated:null}]} as GeneratedCrudTable;
  const name={name:'name',sourceField:'name',type:'text',required:true,primaryKey:false,generated:null,defaultTemplate:'Budget {{fiscalYear.code}}'};
  const fk={name:'fiscal_year_id',sourceField:'fiscalYearId',type:'uuid',required:true,primaryKey:false,generated:null};
  const budget={columns:[name,fk],source:{graphql:{relationships:[{name:'fiscalYearId',fieldKey:'fiscalYearId',target:actual.source!.graphql!.typeName,resolve:'belongsTo',foreignKey:fk.name}]}}} as GeneratedCrudTable;
  const session={tenantId,userId:randomUUID(),roles:['Finance.All.ReadWrite'],groups:[],scope:'self' as const};
  const run=(current=session,selected=year,explicit?:string)=>withDbSession(runtime.db,current,trx=>applyDefaultTemplates(trx,current,budget,new Map([[fk,id],...(explicit===undefined?[]:[[name,explicit] as const])]),[selected]));
  expect((await run()).get(name)).toBe('Budget 2027');expect((await run(session,year,'My plan')).get(name)).toBe('My plan');
  await expect(run({...session,tenantId:randomUUID()})).rejects.toMatchObject({operationError:{code:'VALIDATION'}});
  await expect(run({...session,roles:[]})).rejects.toBeDefined();
  const redacted={...year,columns:year.columns.map(c=>c.name==='code'?{...c,fieldPolicy:{readRoles:['Secret.Read']}}:c)};
  await expect(run(session,redacted)).rejects.toMatchObject({operationError:{code:'VALIDATION'}});
 }finally{await runtime.close();await admin.unsafe(`drop database "${database}" with (force)`);await admin.close();}
},30000);
