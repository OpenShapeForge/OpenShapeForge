// SPDX-License-Identifier: BUSL-1.1
import {test,expect} from 'bun:test';
import {SQL} from 'bun';
import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {createDatabaseRuntime} from '../connection.js';
test('file policies allow empty channel variants and reject actual blocks through every owner shape',async()=>{
 // Load the compiler as the separate owner; do not pull its TS project into the API rootDir.
 const {documentFieldInvariants}=await import(new URL('../../../../../packages/compiler/src/document-field-invariants.ts',import.meta.url).href);
 const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const name='document_policy_'+randomUUID().replaceAll('-','');const admin=new SQL(adminUrl,{max:1});let runtime:ReturnType<typeof createDatabaseRuntime>|undefined;
 try{
  await admin.unsafe(`create database "${name}"`);const url=new URL(adminUrl);url.pathname='/'+name;runtime=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:1});const db=runtime.db;
  for(const ddl of [
   'create schema app','create schema erp',
   'create table erp.documents(id uuid primary key,tenant_id uuid,document_type text,current_version_id uuid)',
   'create table erp.document_versions(id uuid primary key,tenant_id uuid,artifact_id uuid,mime_type text,byte_size bigint)',
   'create table erp.document_variants(id uuid primary key,tenant_id uuid,document_id uuid)',
   'create table erp.blocks(id uuid primary key,tenant_id uuid,document_variant_id uuid)',
   'create table erp.typed_settings(tenant_id uuid,document_id uuid,definition jsonb)',
   'create table erp.authored_settings(tenant_id uuid,document_id uuid)',
  ])await sql.raw(ddl).execute(db);
  const manifest={tables:[
   {schema:'erp',name:'typed_settings',columns:[{name:'value',typedBy:{definitionColumn:'definition',documentColumn:'document_id'}}]},
   {schema:'erp',name:'authored_settings',columns:[{name:'document_id',document:{content:'file',mimeTypes:['image/png'],maxBytes:100}}]},
  ]};
  await sql.raw(documentFieldInvariants(manifest)!).execute(db);
  const tenant=randomUUID();
  for(const table of ['typed_settings','authored_settings']){
   const doc=randomUUID(),version=randomUUID(),variant=randomUUID();
   await sql`insert into erp.document_versions values(${version}::uuid,${tenant}::uuid,${randomUUID()}::uuid,'image/png',50)`.execute(db);
   await sql`insert into erp.documents values(${doc}::uuid,${tenant}::uuid,'attachment',${version}::uuid)`.execute(db);
   await sql`insert into erp.document_variants values(${variant}::uuid,${tenant}::uuid,${doc}::uuid)`.execute(db);
   if(table==='typed_settings')await sql`insert into erp.typed_settings values(${tenant}::uuid,${doc}::uuid,'{"osfType":"Document","document":{"content":"file","mimeTypes":["image/png"],"maxBytes":100}}'::jsonb)`.execute(db);
   else await sql`insert into erp.authored_settings values(${tenant}::uuid,${doc}::uuid)`.execute(db);
   await expect(sql`insert into erp.blocks values(${randomUUID()}::uuid,${tenant}::uuid,${variant}::uuid)`.execute(db)).rejects.toThrow('Document does not satisfy');
  }
  const doc=randomUUID(),version=randomUUID();
  await sql`insert into erp.document_versions values(${version}::uuid,${tenant}::uuid,null,null,null)`.execute(db);
  await sql`insert into erp.documents values(${doc}::uuid,${tenant}::uuid,'note',${version}::uuid)`.execute(db);
  await sql`insert into erp.typed_settings values(${tenant}::uuid,${doc}::uuid,'{"osfType":"Document","document":{"content":"blocks"}}'::jsonb)`.execute(db);
  expect((await sql<{count:number}>`select count(*)::int as count from erp.blocks`.execute(db)).rows[0]?.count).toBe(0);
 }finally{await runtime?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close();}
},30000);
