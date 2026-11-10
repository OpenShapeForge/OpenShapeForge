// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { OpenShapeForgeDatabase } from '../connection.js';
import {databaseRole} from '../database-roles.js';
const roleIdentifier=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export const CONNECTION_USE_GRANTS_PRIVILEGES_SQL = `
revoke all on function app.delegated_connection_row(uuid,text,boolean), app.delegated_connection_token_update(uuid,text,jsonb) from public;
revoke all on function app.delegated_connection_row(uuid,text,boolean), app.delegated_connection_token_update(uuid,text,jsonb) from ${roleIdentifier(databaseRole('worker').name)};
grant execute on function app.delegated_connection_row(uuid,text,boolean), app.delegated_connection_token_update(uuid,text,jsonb) to ${roleIdentifier(databaseRole('app').name)};
`;

export const CONNECTION_USE_GRANTS_SQL = String.raw`
-- No bypass may widen the tenant fence on grants themselves.
drop policy if exists connection_use_grants_tenant_fence on platform.connection_use_grants;
create policy connection_use_grants_tenant_fence on platform.connection_use_grants
  as restrictive for all using (tenant_id=app.current_tenant()) with check (tenant_id=app.current_tenant());

create or replace function app.connection_grant_owner_live(identity_id uuid, tenant_id uuid, relation_id uuid)
returns boolean language sql stable as $$
  select exists(select 1 from platform.identity_relations m
    where m.identity_id=$1 and m.tenant_id=$2 and m.relation_id=$3
      and m.status='linked' and not m.access_blocked)
$$;
-- Stable index name: uniqueness is the live consent scope, not the issuing identity.
create unique index if not exists connection_use_grants_live_identity on platform.connection_use_grants
  (tenant_id,subject_entity,subject_id,connection_id,consumer_operation,(service_definition->>'id')) where revoked_at is null;

-- The normal generated tenant policy still applies. Only the connection owner
-- may issue or revoke authority; all grant scope fields are immutable.
drop policy if exists connection_use_grants_owner_insert on platform.connection_use_grants;
create policy connection_use_grants_owner_insert on platform.connection_use_grants
  as restrictive for insert with check (
    owner_relation_id=app.current_relation_id() and issued_by=app.current_user_id()
    and app.connection_grant_owner_live(issued_identity_id,tenant_id,owner_relation_id)
    -- Keep inline: identity-link migration drops identity_subject on each chain run.
    and exists(select 1 from platform.identities i where i.id=issued_identity_id
      and i.subject=current_setting('app.user_id',true))
  );
drop policy if exists connection_use_grants_owner_update on platform.connection_use_grants;
create policy connection_use_grants_owner_update on platform.connection_use_grants
  as restrictive for update using ((owner_relation_id=app.current_relation_id() or 'Organization.All.ReadWrite'=any(string_to_array(coalesce(current_setting('app.roles',true),''),',')) or not app.connection_grant_owner_live(issued_identity_id,tenant_id,owner_relation_id)))
  with check ((owner_relation_id=app.current_relation_id() or 'Organization.All.ReadWrite'=any(string_to_array(coalesce(current_setting('app.roles',true),''),',')) or not app.connection_grant_owner_live(issued_identity_id,tenant_id,owner_relation_id)));
drop policy if exists connection_use_grants_owner_delete on platform.connection_use_grants;
create policy connection_use_grants_owner_delete on platform.connection_use_grants
  as restrictive for delete using (false); -- withdraw through revoked_at; retain the consent record

create or replace function app.connection_use_grant_immutable() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'FORBIDDEN: Connection permission scope is immutable.';
  end if;
  return new;
end $$;
drop trigger if exists connection_use_grant_immutable on platform.connection_use_grants;
create trigger connection_use_grant_immutable before update on platform.connection_use_grants
  for each row execute function app.connection_use_grant_immutable();

-- The membership write was already authorized. Scope its cascading withdrawal
-- to that row's tenant even for a cross-tenant maintenance session. No identity
-- or bypass is elevated. Normal completion restores context explicitly; errors
-- restore transaction-local settings through PostgreSQL rollback.
create or replace function app.connection_grants_membership_changed() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare previous_tenant text := current_setting('app.tenant_id',true);
begin
  perform set_config('app.tenant_id',old.tenant_id::text,true);
  update platform.connection_use_grants g set revoked_at=clock_timestamp()
    where g.tenant_id=old.tenant_id and g.issued_identity_id=old.identity_id and g.revoked_at is null
      and not app.connection_grant_owner_live(g.issued_identity_id,g.tenant_id,g.owner_relation_id);
  perform set_config('app.tenant_id',coalesce(previous_tenant,''),true);
  return null;
end $$;
drop trigger if exists connection_grants_membership_changed on platform.identity_relations;
create trigger connection_grants_membership_changed after update of status,access_blocked,identity_id,tenant_id,relation_id or delete on platform.identity_relations
  for each row execute function app.connection_grants_membership_changed();

-- One bounded lookup, after core admitted the stored consuming Operation.
-- The helper never changes the user's identity or leaves RLS bypass enabled.
create or replace function app.delegated_connection_row(grant_id uuid, operation_id text, lock_row boolean default false)
returns jsonb language plpgsql volatile parallel unsafe as $$
declare
  permission platform.connection_use_grants%rowtype;
  previous_bypass text := current_setting('app.bypass_rls',true);
  result jsonb;
  parts text[];
begin
  select * into permission from platform.connection_use_grants g
    where g.id=grant_id and g.tenant_id=app.current_tenant()
      and g.consumer_operation=operation_id and g.revoked_at is null
      and app.connection_grant_owner_live(g.issued_identity_id,g.tenant_id,g.owner_relation_id)
      and (g.expires_at is null or g.expires_at>clock_timestamp());
  if permission.id is null then return null; end if;
  if current_setting('app.audit_operation',true) is distinct from operation_id then return null; end if;
  parts := string_to_array(permission.connection_table,'.');
  if cardinality(parts)<>2 or parts[1]!~'^[a-z_][a-z0-9_]*$' or parts[2]!~'^[a-z_][a-z0-9_]*$' then return null; end if;
  perform set_config('app.bypass_rls','true',true);
  execute format('select to_jsonb(c) from %I.%I c where c.id=$1 and c.tenant_id=$2 and c.owner_user_id=$3 %s',
    parts[1],parts[2],case when lock_row then 'for update' else '' end)
    into result using permission.connection_id,permission.tenant_id,permission.owner_relation_id;
  perform set_config('app.bypass_rls',coalesce(previous_bypass,''),true);
  -- A refresh may have waited for the connection lock. Do not carry an
  -- authorization snapshot from before that wait into token renewal.
  if not exists (select 1 from platform.connection_use_grants g where g.id=grant_id
      and g.tenant_id=app.current_tenant() and g.consumer_operation=operation_id
      and g.revoked_at is null and app.connection_grant_owner_live(g.issued_identity_id,g.tenant_id,g.owner_relation_id) and (g.expires_at is null or g.expires_at>clock_timestamp())) then
    return null;
  end if;
  return result;
exception when others then
  perform set_config('app.bypass_rls',coalesce(previous_bypass,''),true);
  raise;
end $$;

create or replace function app.delegated_connection_token_update(grant_id uuid, operation_id text, token_values jsonb)
returns boolean language plpgsql volatile parallel unsafe as $$
declare
  permission platform.connection_use_grants%rowtype;
  previous_bypass text := current_setting('app.bypass_rls',true);
  current_row jsonb;
  parts text[];
  changed bigint;
begin
  current_row := app.delegated_connection_row(grant_id,operation_id,true);
  if current_row is null then return false; end if;
  select * into permission from platform.connection_use_grants g where g.id=grant_id and g.tenant_id=app.current_tenant()
    and g.consumer_operation=operation_id and g.revoked_at is null and app.connection_grant_owner_live(g.issued_identity_id,g.tenant_id,g.owner_relation_id) and (g.expires_at is null or g.expires_at>clock_timestamp());
  if permission.id is null or permission.values_column!~'^[a-z_][a-z0-9_]*$' then return false; end if;
  parts := string_to_array(permission.connection_table,'.');
  if cardinality(parts)<>2 or parts[1]!~'^[a-z_][a-z0-9_]*$' or parts[2]!~'^[a-z_][a-z0-9_]*$' then return false; end if;
  perform set_config('app.bypass_rls','true',true);
  execute format('update %I.%I set %I=$1 where id=$2 and tenant_id=$3 and owner_user_id=$4',parts[1],parts[2],permission.values_column)
    using token_values,permission.connection_id,permission.tenant_id,permission.owner_relation_id;
  get diagnostics changed = row_count;
  perform set_config('app.bypass_rls',coalesce(previous_bypass,''),true);
  return changed=1;
exception when others then
  perform set_config('app.bypass_rls',coalesce(previous_bypass,''),true);
  raise;
end $$;
${CONNECTION_USE_GRANTS_PRIVILEGES_SQL}
`;

export async function applyConnectionUseGrantsMigration(db: OpenShapeForgeDatabase): Promise<void> {
  await sql.raw(CONNECTION_USE_GRANTS_SQL).execute(db);
}

/** Reapply after the generic EXECUTE sweeps, which otherwise include these helpers. */
export async function applyConnectionUseGrantsPrivileges(db: OpenShapeForgeDatabase): Promise<void> {
  await sql.raw(CONNECTION_USE_GRANTS_PRIVILEGES_SQL).execute(db);
}
