// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import { encryptSecret, keyringFromEnv } from "@openshapeforge/plugin-runtime/secrets";
import type { VersionedMigration } from "../versioned-runner.js";

/** Carry the released scalar/plain JSON contract forward without guessing at
 * inactive values or an untyped array's element contract. Unsupported legacy
 * rows stop the transaction before any data is removed. A fresh build already
 * has the target shape and records this migration as its baseline.
 *
 * ACCESS EXCLUSIVE protects the temporary RLS change: no concurrent reader or
 * writer can access the table until its original RLS flags are restored and
 * the migration transaction commits. Disabling RLS also requires table owner
 * authority; a restricted runtime connection cannot run this transformation.
 */
export async function upgradeTenantSettings(db: Kysely<any>): Promise<void> {
  const columns=await sql<{name:string}>`select attname as name from pg_attribute where attrelid=to_regclass('erp.tenant_settings') and attnum>0 and not attisdropped`.execute(db);
  if(!columns.rows.some(c=>c.name==='value_type'))return;
  if(columns.rows.some(c=>['definition','value'].includes(c.name)))throw Error('Tenant settings have an ambiguous partial upgrade; no values were changed.');
  await sql`lock table erp.tenant_settings in access exclusive mode`.execute(db);
  const flags=await sql<{enabled:boolean;forced:boolean}>`select relrowsecurity as enabled,relforcerowsecurity as forced from pg_class where oid='erp.tenant_settings'::regclass`.execute(db);
  await sql`alter table erp.tenant_settings disable row level security`.execute(db);
  const rows=await sql<{id:string;tenant_id:string;value_type:string;value_text:string|null;value_json:unknown;is_secret:boolean}>`select id::text,tenant_id::text,value_type,value_text,value_json,is_secret from erp.tenant_settings`.execute(db);
  const prepared=rows.rows.map(row=>{
    if(!['string','json'].includes(row.value_type)||(row.value_type==='string'?row.value_json!==null:row.value_text!==null))throw Error('Tenant settings contain unsupported or inactive legacy values; classify these before migrating.');
    const value=row.value_type==='string'?row.value_text:row.value_json;
    const type=value===null?'object':typeof value;
    if(row.value_type==='json'&&(Array.isArray(value)||!['object','string','number','boolean'].includes(type)))throw Error('An untyped JSON array needs an explicit field definition before migrating.');
    if(row.is_secret&&row.value_type!=='string')throw Error('A confidential JSON setting needs an explicit secret contract before migrating.');
    const definition={key:'value',osfType:row.value_type==='string'?'string':type,...(row.is_secret?{classification:{sensitivity:'confidential',category:'credentials'}}:{})};
    let stored=value;
    if(row.is_secret&&value!==null){
      const keys=keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
      if(!keys)throw Error('Configure secure value storage before migrating confidential tenant settings.');
      stored=encryptSecret(keys,`${row.tenant_id}:erp.tenant_settings:${row.id}`,'value',String(value));
    }
    return {id:row.id,definition,stored};
  });
  await sql`alter table erp.tenant_settings add column definition jsonb,add column value jsonb`.execute(db);
  for(const row of prepared)await sql`update erp.tenant_settings set definition=${JSON.stringify(row.definition)}::text::jsonb,value=${row.stored===null?null:JSON.stringify(row.stored)}::text::jsonb where id=${row.id}::uuid`.execute(db);
  await sql`alter table erp.tenant_settings alter column definition set not null,drop column value_type,drop column value_text,drop column value_json,drop column is_secret`.execute(db);
  if(flags.rows[0]?.enabled)await sql`alter table erp.tenant_settings enable row level security`.execute(db);
  if(flags.rows[0]?.forced)await sql`alter table erp.tenant_settings force row level security`.execute(db);
}
const migration: VersionedMigration={version:'0018_typed-tenant-settings',fileUrl:import.meta.url,up:upgradeTenantSettings};
export default migration;
