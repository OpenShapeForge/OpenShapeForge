// SPDX-License-Identifier: BUSL-1.1
import { test, expect } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { createDatabaseRuntime } from '../connection.js';
import { requireComposedRelationColumns } from '../migrations/versioned/0021_relation-required-columns.js';

const tables = (required: boolean) => ['employees','relation_group_memberships'].map(table => ({schema:'erp',table,columns:[{name:'relation_id',type:'uuid',required}]}));
async function scratch(run:(db:Kysely<any>)=>Promise<void>) {
 const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const name='relation_columns_'+randomUUID().replaceAll('-',''); const admin=new SQL(adminUrl,{max:1}); let runtime:ReturnType<typeof createDatabaseRuntime>|undefined;
 try {
  await admin.unsafe(`create database "${name}"`); const url=new URL(adminUrl);url.pathname='/'+name;
  runtime=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:1});
  await sql`create schema erp`.execute(runtime.db);
  await sql`create table erp.employees(id uuid primary key, relation_id uuid)`.execute(runtime.db);
  await sql`create table erp.relation_group_memberships(id uuid primary key, relation_id uuid)`.execute(runtime.db);
  await run(runtime.db);
 } finally { await runtime?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close(); }
}
async function flags(db:Kysely<any>){return (await sql<{table:string;required:boolean}>`select c.relname as "table", a.attnotnull as required from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp' and c.relname in ('employees','relation_group_memberships') and a.attname='relation_id' order by c.relname`.execute(db)).rows;}

test('sets required relation columns without changing valid rows and respects optional composition',async()=>scratch(async db=>{
 const relation=randomUUID(); await sql`insert into erp.employees values(${randomUUID()}::uuid,${relation}::uuid)`.execute(db);
 await db.transaction().execute(tx=>requireComposedRelationColumns(tx,tables(false)));
 expect((await flags(db)).every(c=>!c.required)).toBe(true);
 await db.transaction().execute(tx=>requireComposedRelationColumns(tx,tables(true)));
 expect((await flags(db)).every(c=>c.required)).toBe(true);
 expect((await sql<{relation_id:string}>`select relation_id::text from erp.employees`.execute(db)).rows[0]?.relation_id).toBe(relation);
 await db.transaction().execute(tx=>requireComposedRelationColumns(tx,tables(true)));
}),30000);

test('a null in either table aborts both changes without altering user rows',async()=>scratch(async db=>{
 const id=randomUUID(); await sql`insert into erp.relation_group_memberships values(${id}::uuid,null)`.execute(db);
 await expect(db.transaction().execute(tx=>requireComposedRelationColumns(tx,tables(true)))).rejects.toThrow('contains null values');
 expect((await flags(db)).every(c=>!c.required)).toBe(true);
 expect((await sql<{id:string}>`select id::text from erp.relation_group_memberships`.execute(db)).rows[0]?.id).toBe(id);
}),30000);
