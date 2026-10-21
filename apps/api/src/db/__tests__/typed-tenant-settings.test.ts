// SPDX-License-Identifier: BUSL-1.1
import {test,expect} from 'bun:test';
import {SQL} from 'bun';
import {randomUUID} from 'node:crypto';
import {sql,type Kysely} from 'kysely';
import {createDatabaseRuntime} from '../connection.js';
import {upgradeTenantSettings} from '../migrations/versioned/0018_typed-tenant-settings.js';
import {decryptSecret,keyringFromEnv,type StoredSecret} from '@openshapeforge/plugin-runtime/secrets';
async function scratch(run:(db:Kysely<any>)=>Promise<void>){
 const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const name='typed_settings_'+randomUUID().replaceAll('-','');const admin=new SQL(adminUrl,{max:1});let runtime:ReturnType<typeof createDatabaseRuntime>|undefined;
 try{await admin.unsafe(`create database "${name}"`);const url=new URL(adminUrl);url.pathname='/'+name;runtime=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:1});
 await sql`create schema erp`.execute(runtime.db);
 await sql`create table erp.tenant_settings(id uuid primary key,tenant_id uuid not null,value_type text not null default 'string',value_text text,value_json jsonb,is_secret boolean not null default false)`.execute(runtime.db);
 await sql`alter table erp.tenant_settings enable row level security`.execute(runtime.db);await sql`alter table erp.tenant_settings force row level security`.execute(runtime.db);
 await run(runtime.db);
 }finally{await runtime?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close();}
}
test('released settings retain identities and values, seal secrets and restore RLS',async()=>scratch(async db=>{
 const tenant=randomUUID(),plain=randomUUID(),secret=randomUUID(),json=randomUUID();const original=process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;const keys='fixture:'+Buffer.alloc(32,19).toString('base64');
 try{process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=keys;
 await sql`insert into erp.tenant_settings values(${plain}::uuid,${tenant}::uuid,'string','plain',null,false),(${secret}::uuid,${tenant}::uuid,'string','private fixture',null,true),(${json}::uuid,${tenant}::uuid,'json',null,'{"enabled":true}'::jsonb,false)`.execute(db);
 await db.transaction().execute(upgradeTenantSettings);
 const rows=(await sql<{id:string;definition:{osfType:string};value:unknown}>`select id::text,definition,value from erp.tenant_settings`.execute(db)).rows;
 expect(rows.find(r=>r.id===plain)?.value).toBe('plain');expect(rows.find(r=>r.id===json)?.value).toEqual({enabled:true});const sealed=rows.find(r=>r.id===secret)!;
 expect(JSON.stringify(sealed.value)).not.toContain('private fixture');expect(decryptSecret(keyringFromEnv(keys)!,`${tenant}:erp.tenant_settings:${secret}`,'value',sealed.value as StoredSecret)).toBe('private fixture');
 const flags=(await sql<{enabled:boolean;forced:boolean}>`select relrowsecurity as enabled,relforcerowsecurity as forced from pg_class where oid='erp.tenant_settings'::regclass`.execute(db)).rows[0];expect(flags).toEqual({enabled:true,forced:true});
 await db.transaction().execute(upgradeTenantSettings);
 }finally{if(original===undefined)delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=original;}
}),30000);
test('unsupported legacy values abort without dropping columns, rows or RLS',async()=>scratch(async db=>{
 await sql`insert into erp.tenant_settings values(${randomUUID()}::uuid,${randomUUID()}::uuid,'json',null,'[1,"mixed"]'::jsonb,false)`.execute(db);
 await expect(db.transaction().execute(upgradeTenantSettings)).rejects.toThrow('explicit field definition');
 expect((await sql`select value_json from erp.tenant_settings`.execute(db)).rows).toEqual([{value_json:[1,'mixed']}]);
 expect((await sql<{enabled:boolean}>`select relrowsecurity as enabled from pg_class where oid='erp.tenant_settings'::regclass`.execute(db)).rows[0]?.enabled).toBe(true);
}),30000);
