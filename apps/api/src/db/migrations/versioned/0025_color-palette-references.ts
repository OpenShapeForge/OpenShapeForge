// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import { STANDARD_COLORS, parseTenantColors } from '@openshapeforge/operations';
import type { VersionedMigration } from '../versioned-runner.js';
import { colorReferenceTables } from '../../../operations/entity/color-references.js';
const migration: VersionedMigration = {
  version:'0025_color-palette-references', fileUrl:import.meta.url,
  async up(db) {
    await sql`select set_config('app.bypass_rls','true',true)`.execute(db);
    const tenants=await sql<{id:string}>`select id from erp.tenants`.execute(db);
    for(const tenant of tenants.rows) {
      const rows=await sql<{id:string;value:unknown}>`select id,value from erp.tenant_settings where tenant_id=${tenant.id}::uuid and namespace='appearance' and key='colors' for update`.execute(db);
      if(rows.rows.length>1)throw Error('Duplicate palette settings.');
      const colors=rows.rows[0]?parseTenantColors(rows.rows[0].value):[];
      for(const table of colorReferenceTables)for(const column of table.columns.filter(c=>c.colorReference)) {
        const exists=await sql<{present:boolean}>`select exists(select 1 from information_schema.columns where table_schema=${table.schema} and table_name=${table.table} and column_name=${column.name}) as present`.execute(db);
        if(!exists.rows[0]?.present)continue;
        await sql`alter table ${sql.id(table.schema,table.table)} drop constraint if exists ${sql.id(`${table.table}_${column.name}_pattern_check`)}`.execute(db);
        const values=await sql<{value:string}>`select distinct ${sql.id(column.name)} as value from ${sql.id(table.schema,table.table)} where tenant_id=${tenant.id}::uuid and ${sql.id(column.name)} ~ '^#[0-9A-Fa-f]{6}$'`.execute(db);
        for(const {value} of values.rows) {
          const standard=STANDARD_COLORS.find(c=>c.value.toLowerCase()===value.toLowerCase());
          let reference=standard?`standard:${standard.key}`:undefined;
          if(!reference) {
            const key=`imported-${value.slice(1).toLowerCase()}`;
            const existing=colors.find(c=>c.key===key);
            if(existing&&existing.value.toLowerCase()!==value.toLowerCase())throw Error('Imported palette key collision.');
            if(!existing)colors.push({key,name:`Existing ${value.toUpperCase()}`,value:value.toUpperCase(),active:true});
            reference=`tenant:${key}`;
          }
          await sql`update ${sql.id(table.schema,table.table)} set ${sql.id(column.name)}=${reference} where tenant_id=${tenant.id}::uuid and ${sql.id(column.name)}=${value}`.execute(db);
        }
      }
      const value=JSON.stringify({colors});
      if(rows.rows[0])await sql`update erp.tenant_settings set value=${value}::text::jsonb where id=${rows.rows[0].id}::uuid and tenant_id=${tenant.id}::uuid`.execute(db);
      else await sql`insert into erp.tenant_settings(id,tenant_id,namespace,key,definition,value,description) values(gen_random_uuid(),${tenant.id}::uuid,'appearance','colors','{"key":"value","osfType":"colorPalette","label":{"en":"Custom colors","nl":"Eigen kleuren"}}'::jsonb,${value}::text::jsonb,'Eigen kleuren / Custom colors')`.execute(db);
    }
    for(const [column,value] of [['surface_color','standard:white'],['text_color','standard:ink'],['accent_color','standard:cobalt']]) {
      const exists=await sql<{present:boolean}>`select exists(select 1 from information_schema.columns where table_schema='erp' and table_name='document_themes' and column_name=${column}) as present`.execute(db);
      if(exists.rows[0]?.present)await sql`alter table erp.document_themes alter column ${sql.id(column!)} set default ${sql.lit(value!)}`.execute(db);
    }
  }
};
export default migration;
