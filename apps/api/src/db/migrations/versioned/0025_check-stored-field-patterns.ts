// SPDX-License-Identifier: BUSL-1.1
import {sql,type Kysely} from 'kysely';
import {schemaRegExp} from '@openshapeforge/operations';
import type {VersionedMigration} from '../versioned-runner.js';

/** A non-destructive upgrade gate for the narrower validation dialect.
 * Inspect only stored FieldDefinition validation.pattern members, not arbitrary
 * business properties named pattern. Refuse incompatible definitions for an
 * operator to correct explicitly; never silently weaken a validation rule.
 * The versioned runner supplies the transaction. The savepoint restores all
 * temporary tenant/bypass settings on success and on failure.
 */
export async function checkStoredFieldPatterns(db:Kysely<any>):Promise<void>{
 await sql`savepoint osf_field_pattern_audit`.execute(db);
 try{
  const {rows:columns}=await sql<{schema:string;table:string;column:string;tenant:boolean}>`
   select n.nspname as schema,c.relname as table,a.attname as column,
    exists(select 1 from pg_attribute t where t.attrelid=c.oid and t.attname='tenant_id' and t.attnum>0 and not t.attisdropped) as tenant
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
    and a.atttypid in ('jsonb'::regtype,'json'::regtype)
    and n.nspname not like 'pg_%' and n.nspname<>'information_schema'
   order by n.nspname,c.relname,a.attname
  `.execute(db);
  await sql`select set_config('app.bypass_rls','true',true)`.execute(db);
  const {rows:[registry]}=await sql<{exists:boolean}>`select to_regclass('platform.tenants') is not null as exists`.execute(db);
  const tenants=registry?.exists?(await sql<{id:string}>`select id::text as id from platform.tenants`.execute(db)).rows.map(row=>row.id):[];
  for(const column of columns){
   for(const tenant of column.tenant?tenants:[null]){
    await sql`select set_config('app.tenant_id',${tenant??''},true)`.execute(db);
    const {rows:patterns}=await sql<{pattern:string}>`
     select distinct p.value #>> '{}' as pattern from ${sql.id(column.schema,column.table)} t
      cross join lateral jsonb_path_query(t.${sql.id(column.column)}::jsonb,'$.**.validation.pattern') p(value)
     where jsonb_typeof(p.value)='string'
      and ${column.tenant?sql`t.tenant_id::text=${tenant}`:sql`true`} limit 10001
    `.execute(db);
    if(patterns.length>10000)throw Error('Stored FieldDefinition pattern audit exceeded its bound; inspect definitions before upgrading.');
    for(const row of patterns){
     try{schemaRegExp(row.pattern);}
     catch{throw Error(`Stored FieldDefinition validation pattern is unsupported in ${column.schema}.${column.table}.${column.column}; correct the definition before upgrading. No pattern values or records were changed.`);}
    }
   }
  }
 }finally{
  await sql`rollback to savepoint osf_field_pattern_audit`.execute(db);
  await sql`release savepoint osf_field_pattern_audit`.execute(db);
 }
}
const migration:VersionedMigration={
 version:'0025_check-stored-field-patterns',fileUrl:import.meta.url,
 up:checkStoredFieldPatterns,
};
export default migration;
