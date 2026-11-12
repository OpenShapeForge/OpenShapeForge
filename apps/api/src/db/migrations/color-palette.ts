// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import {COLOR_PALETTE_MAX_COLORS,COLOR_VALUE_PATTERN} from '@openshapeforge/operations';
import type { OpenShapeForgeDatabase } from '../connection.js';
import { databaseRole } from '../database-roles.js';
import { APP_ROLE } from './app-role.js';
import { WORKER_ROLE } from './worker-role.js';

/** Public appearance data only: never a general TenantSetting/RLS escape hatch. */
export async function applyPublicColorPaletteMigration(db: OpenShapeForgeDatabase) {
  const resolver=databaseRole('identityResolver').name;
  await sql`grant usage on schema erp,app to ${sql.id(resolver)}`.execute(db);
  await sql`grant select(tenant_id,namespace,key,value) on erp.tenant_settings to ${sql.id(resolver)}`.execute(db);
  await sql`drop policy if exists public_color_palette_lookup on erp.tenant_settings`.execute(db);
  await sql`create policy public_color_palette_lookup on erp.tenant_settings for select to ${sql.id(resolver)} using(tenant_id=app.current_tenant() and namespace='appearance' and key='colors')`.execute(db);
  // Resolver membership is inherited by the restricted migrator too. Only this
  // table's owner may migrate all tenants; the definer keeps its tenant/key fence.
  const ownsTable=sql`coalesce((select pg_catalog.pg_has_role(current_user,c.relowner,'USAGE') from pg_catalog.pg_class c where c.oid='erp.tenant_settings'::regclass),false)`;
  await sql`drop policy if exists public_color_palette_scope on erp.tenant_settings`.execute(db);
  await sql`create policy public_color_palette_scope on erp.tenant_settings as restrictive for select to ${sql.id(resolver)} using(${ownsTable} or (tenant_id=app.current_tenant() and namespace='appearance' and key='colors'))`.execute(db);
  await sql`
    grant create on schema app to ${sql.id(resolver)};
    create or replace function app.public_color_palette(requested_tenant uuid) returns table(value jsonb)
    language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $function$
    begin
      if requested_tenant is null or requested_tenant is distinct from app.current_tenant() then
        raise exception 'A matching tenant session is required.' using errcode='42501';
      end if;
      return query select case when jsonb_typeof(s.value)='object' then case when s.value-'colors'='{}'::jsonb
        and jsonb_typeof(s.value->'colors')='array' then case when jsonb_array_length(s.value->'colors')<=${sql.lit(COLOR_PALETTE_MAX_COLORS)} then
        jsonb_build_object('colors',(select coalesce(jsonb_agg(case when jsonb_typeof(c.item)='object' then case when
          c.item-array['key','name','value','active']='{}'::jsonb
          and jsonb_typeof(c.item->'key')='string' and c.item->>'key' ~ '^[a-z][a-z0-9-]{0,63}$'
          and jsonb_typeof(c.item->'name')='string' and length(btrim(c.item->>'name')) between 1 and 100
          and length(c.item->>'name')<=100
          and jsonb_typeof(c.item->'value')='string' and c.item->>'value' ~ ${sql.lit(COLOR_VALUE_PATTERN)}
          and jsonb_typeof(c.item->'active')='boolean' then
          jsonb_build_object('key',c.item->'key','name',c.item->'name','value',c.item->'value','active',c.item->'active')
          else 'null'::jsonb end else 'null'::jsonb end order by c.ordinal),'[]'::jsonb)
          from jsonb_array_elements(s.value->'colors') with ordinality as c(item,ordinal)))
        else 'null'::jsonb end else 'null'::jsonb end else 'null'::jsonb end
        from erp.tenant_settings s where s.tenant_id=requested_tenant and s.namespace='appearance' and s.key='colors';
    end;
    $function$;
    revoke all on function app.public_color_palette(uuid) from public,${sql.id(WORKER_ROLE)};
    grant execute on function app.public_color_palette(uuid) to ${sql.id(APP_ROLE)};
    alter function app.public_color_palette(uuid) owner to ${sql.id(resolver)};
    revoke create on schema app from ${sql.id(resolver)};
  `.execute(db);
}
