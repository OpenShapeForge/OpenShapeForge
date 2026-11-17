// SPDX-License-Identifier: BUSL-1.1
import {sql,type Kysely} from 'kysely';
import {schemaRegExp} from '@openshapeforge/operations';
import manifest from '../../../generated/db/manifest.json' with {type:'json'};
import type {VersionedMigration} from '../versioned-runner.js';
type Owned={schema:string;table:string;children:readonly Owned[]};
type DefinitionColumn={name:string;immutable?:boolean;storedFieldDefinition?:'single'|'collection';path?:string;sourceColumn?:string};
type DefinitionTable={schema:string;table:string;tenantScoped:boolean;columns:readonly DefinitionColumn[];source?:{versioning?:{storage:{version:{schema:string;table:string};owned:readonly Owned[]}}}};
function definitionCarriers(tables:readonly DefinitionTable[]){
 const carriers=tables.flatMap(table=>table.columns.filter(c=>c.storedFieldDefinition).map(column=>({table,column})));
 for(const head of tables){
  const storage=head.source?.versioning?.storage;if(!storage)continue;
  const version=tables.find(t=>t.schema===storage.version.schema&&t.table===storage.version.table);
  if(!version?.columns.some(c=>c.name==='snapshot'))continue;
  const visit=(table:DefinitionTable,path:string,owned:readonly Owned[])=>{
   for(const field of table.columns.filter(c=>c.storedFieldDefinition))carriers.push({table:version,column:{name:'snapshot',immutable:true,storedFieldDefinition:field.storedFieldDefinition!,sourceColumn:table.schema+'.'+table.table+'.'+field.name,path:path+'.row.'+JSON.stringify(field.name)+(field.storedFieldDefinition==='collection'?'[*]':'')}});
   for(const child of owned){const target=tables.find(t=>t.schema===child.schema&&t.table===child.table);if(target)visit(target,path+'.children.'+JSON.stringify(child.schema+'.'+child.table)+'[*]',child.children);}
  };
  visit(head,'$.head',storage.owned);
 }
 return carriers;
}

/** Check compiler-declared FieldDefinition columns and their compiler-bound
 * published snapshot positions. Immutable incompatibilities require an owner
 * disposition before upgrade; the audit never rewrites frozen data. Within a
 * definition, visit only its canonical shape/children/item field positions.
 * The savepoint restores temporary tenant/bypass settings even on refusal.
 */
export async function checkStoredFieldPatterns(db:Kysely<any>,tables:readonly DefinitionTable[]=manifest.tables as DefinitionTable[]):Promise<void>{
 await sql`savepoint osf_field_pattern_audit`.execute(db);
 try{
  const declared=definitionCarriers(tables);
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
       cross join lateral jsonb_path_query(t.${sql.id(column.name)}::jsonb,${column.path??(column.storedFieldDefinition==='collection'?'$[*]':'$')}::jsonpath) f(value)
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
     catch{throw Error(`Stored FieldDefinition validation pattern is unsupported in ${table.schema}.${table.table}.${column.name}; ${column.immutable ? "immutable definition requires a reviewed owner data disposition before upgrading; retain the previous release and consult docs/migrations.md" : "correct the editable definition before upgrading"}. No definitions or records were changed.`);}
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
