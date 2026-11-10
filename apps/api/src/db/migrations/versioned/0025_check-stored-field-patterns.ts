// SPDX-License-Identifier: BUSL-1.1
import {sql,type Kysely} from 'kysely';
import {schemaRegExp} from '@openshapeforge/operations';
import manifest from '../../../generated/db/manifest.json' with {type:'json'};
import type {VersionedMigration} from '../versioned-runner.js';
type DefinitionTable={schema:string;table:string;tenantScoped:boolean;columns:readonly {name:string;immutable?:boolean;storedFieldDefinition?:'single'|'collection'}[]};

/** Check only mutable, compiler-declared FieldDefinition columns. Historical
 * snapshots and arbitrary JSON values are not editable definitions. Within a
 * definition, visit only its canonical shape/children/item field positions.
 * The savepoint restores temporary tenant/bypass settings even on refusal.
 */
export async function checkStoredFieldPatterns(db:Kysely<any>,tables:readonly DefinitionTable[]=manifest.tables as DefinitionTable[]):Promise<void>{
 await sql`savepoint osf_field_pattern_audit`.execute(db);
 try{
  const declared=tables.flatMap(t=>t.columns.filter(c=>c.storedFieldDefinition&&!c.immutable).map(c=>({table:t,column:c})));
  if(!declared.length)return;
  await sql`select set_config('app.bypass_rls','true',true)`.execute(db);
  const {rows:[registry]}=await sql<{exists:boolean}>`select to_regclass('platform.tenants') is not null as exists`.execute(db);
  const tenants=registry?.exists?(await sql<{id:string}>`select id::text as id from platform.tenants`.execute(db)).rows.map(row=>row.id):[];
  for(const {table,column} of declared){
   // A new or removed column is handled by generated schema roll-forward.
   const existing=await sql`select 1 from pg_attribute where attrelid=to_regclass(${table.schema+'.'+table.table})
    and attname=${column.name} and attnum>0 and not attisdropped and atttypid in ('jsonb'::regtype,'json'::regtype)`.execute(db);
   if(!existing.rows.length)continue;
   for(const tenant of table.tenantScoped?tenants:[null]){
    await sql`select set_config('app.tenant_id',${tenant??''},true)`.execute(db);
    const {rows:patterns}=await sql<{pattern:string}>`
     with recursive definitions(value) as (
      select f.value from ${sql.id(table.schema,table.table)} t
       cross join lateral jsonb_path_query(t.${sql.id(column.name)}::jsonb,${column.storedFieldDefinition==='collection'?'$[*]':'$'}::jsonpath) f(value)
       where ${table.tenantScoped?sql`t.tenant_id=${tenant}::uuid`:sql`true`}
      union all
      select nested.value from definitions d cross join lateral (
       select value from jsonb_array_elements(case when jsonb_typeof(d.value->'shape')='array' then d.value->'shape' else '[]'::jsonb end)
       union all
       select value from jsonb_array_elements(case when jsonb_typeof(d.value->'children')='array' then d.value->'children' else '[]'::jsonb end)
       union all
       select d.value->'item' where jsonb_typeof(d.value->'item')='object'
      ) nested
     )
     select distinct value->'validation'->>'pattern' as pattern from definitions
      where jsonb_typeof(value->'validation'->'pattern')='string' limit 10001
    `.execute(db);
    if(patterns.length>10000)throw Error('Stored FieldDefinition pattern audit exceeded its bound; inspect definitions before upgrading.');
    for(const row of patterns){
     try{schemaRegExp(row.pattern);}
     catch{throw Error(`Stored FieldDefinition validation pattern is unsupported in ${table.schema}.${table.table}.${column.name}; correct the editable definition before upgrading. Historical snapshots and records were not changed.`);}
    }
   }
  }
 }finally{
  await sql`rollback to savepoint osf_field_pattern_audit`.execute(db);
  await sql`release savepoint osf_field_pattern_audit`.execute(db);
 }
}
const migration:VersionedMigration={version:'0025_check-stored-field-patterns',fileUrl:import.meta.url,async up(db){await checkStoredFieldPatterns(db);}};
export default migration;
