// SPDX-License-Identifier: BUSL-1.1
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import type { OpenShapeForgeDatabase } from '../connection.js';
import { applyCatalogSeed } from './catalog-seed.js';
import { jsonbLiteral } from '../sql-helpers.js';
import manifest from '../../generated/db/manifest.json' with { type: 'json' };
import type { GeneratedCrudTable } from '../../operations/entity/types.js';
import roleComposites from '../../generated/compiler/role-composites.json' with {type:'json'};
import { expandRoleComposites } from '../../auth/person-roles.js';
import { memberRoleClientId } from '../../auth/employee-invitations.js';
import compiledInventory from '../../generated/compiler/authorization-operations.json' with {type:'json'};
import accessPolicy from '../../generated/compiler/access-policy.json' with {type:'json'};
import { databaseRole } from '../database-roles.js';
import { APP_ROLE } from './app-role.js';

type InventorySeed = { checksum: string; rows: Array<{ id:string; entity:string; roles:string[]; grantable:boolean; fields:Record<string,{column:string;type:string}> }> };
export async function applyAuthorizationProfilesMigration(db: OpenShapeForgeDatabase) {
  await installAuthorizationConditionFunctions(db);
  await applyCatalogSeed<InventorySeed>(db, {
    path:fileURLToPath(new URL('../../generated/compiler/authorization-operations.json', import.meta.url)),
    rowCount:seed=>seed.rows.length,
    probe:async(db,checksum)=>{
      return (await sql<{total:number;current:number}>`select count(*)::int as total,count(*) filter(where checksum=${checksum})::int as current from platform.authorization_operation_inventory`.execute(db)).rows[0]!;
    },
    write:async(tx,seed)=>{
      const ids=seed.rows.map(row=>row.id);
      if(ids.length)await sql`delete from platform.authorization_operation_inventory where id not in (${sql.join(ids.map(id=>sql`${id}`))})`.execute(tx);
      else await sql`delete from platform.authorization_operation_inventory`.execute(tx);
      for(const row of seed.rows)await sql`insert into platform.authorization_operation_inventory(id,entity_name,roles,grantable,fields,checksum)
        values(${row.id},${row.entity},array(select jsonb_array_elements_text(${jsonbLiteral(row.roles)})),${row.grantable},${jsonbLiteral(row.fields)},${seed.checksum})
        on conflict(id) do update set entity_name=excluded.entity_name,roles=excluded.roles,grantable=excluded.grantable,fields=excluded.fields,checksum=excluded.checksum`.execute(tx);
    },
  });
  await sql`grant select on platform.authorization_operation_inventory to ${sql.id(APP_ROLE)}`.execute(db);
  await sql`revoke insert,update,delete,truncate on platform.authorization_operation_inventory from ${sql.id(APP_ROLE)}`.execute(db);
  await installAuthorizationPolicyFunctions(db);
  await installAuthorizationRowPolicies(db);
}

/** Same bounded canonical AST used by the application validator, evaluated inside RLS. */
export async function installAuthorizationConditionFunctions(db: OpenShapeForgeDatabase) {
  await sql`
    create or replace function app.authorization_condition_allows(condition jsonb, resource jsonb, actor jsonb, fields jsonb, depth integer default 0)
    returns boolean language plpgsql stable parallel safe as $function$
    declare children jsonb; child jsonb; mode text; lhs jsonb; rhs jsonb; path text[]; operator text; value jsonb; column_name text;
    begin
      if condition is null or condition = 'null'::jsonb then return true; end if;
      if depth > 16 or jsonb_typeof(condition) <> 'object' then return false; end if;
      if condition ? 'conditions' or condition ? 'all' or condition ? 'any' then
        children := coalesce(condition->'conditions',condition->'all',condition->'any');
        mode := coalesce(condition->>'mode',case when condition ? 'any' then 'any' else 'all' end);
        if jsonb_typeof(children) <> 'array' or jsonb_array_length(children) = 0 or jsonb_array_length(children) > 200 or mode not in ('all','any') then return false; end if;
        for child in select jsonb_array_elements(children) loop
          if app.authorization_condition_allows(child,resource,actor,fields,depth+1) then
            if mode='any' then return true; end if;
          elsif mode='all' then return false;
          end if;
        end loop;
        return mode='all';
      end if;
      operator := condition->>'operator';
      if condition#>>'{left,kind}' <> 'path' then return false; end if;
      path := string_to_array(condition#>>'{left,path}', '.');
      if cardinality(path) <> 2 or path[1] <> 'resource' then return false; end if;
      column_name := fields->path[2]->>'column';
      if column_name is null then return false; end if;
      lhs := resource->column_name;
      if condition#>>'{right,kind}'='literal' then rhs := condition#>'{right,value}';
      elsif condition#>>'{right,kind}'='path' then
        path := string_to_array(condition#>>'{right,path}', '.');
        if cardinality(path) <> 2 or path[1] <> 'actorRelation' then return false; end if;
        rhs := actor->path[2];
      else return false;
      end if;
      if lhs is null or rhs is null or lhs='null'::jsonb or rhs='null'::jsonb then return false; end if;
      if operator in ('equals','notEquals') then
        if jsonb_typeof(lhs) not in ('string','number','boolean') or jsonb_typeof(lhs) <> jsonb_typeof(rhs) then return false; end if;
        return case when operator='equals' then lhs=rhs else lhs<>rhs end;
      elsif operator in ('in','notIn') then
        if jsonb_typeof(rhs)<>'array' or jsonb_array_length(rhs)=0 or jsonb_array_length(rhs)>100 then return false; end if;
        for value in select jsonb_array_elements(rhs) loop
          if jsonb_typeof(lhs)<>jsonb_typeof(value) or jsonb_typeof(value) not in ('string','number','boolean') then return false; end if;
        end loop;
        return case when operator='in' then rhs @> jsonb_build_array(lhs) else not (rhs @> jsonb_build_array(lhs)) end;
      elsif operator in ('contains','notContains') then
        if jsonb_typeof(lhs)<>'string' or jsonb_typeof(rhs)<>'string' then return false; end if;
        return case when operator='contains' then strpos(lhs#>>'{}',rhs#>>'{}')>0 else strpos(lhs#>>'{}',rhs#>>'{}')=0 end;
      end if;
      return false;
    exception when others then return false;
    end;
    $function$;
  `.execute(db);
}

export async function installAuthorizationPolicyFunctions(db: OpenShapeForgeDatabase) {
  const {entityTableName,entityColumnName}=await import('../manifest-lookup.js');
  const table=(entity:string)=>sql.table(entityTableName(entity));
  const col=(alias:string,entity:string,field:string)=>sql.ref(alias+'.'+entityColumnName(entity,field));
  const knownRoles=[...new Set([...accessPolicy.roles,...accessPolicy.permissions,...compiledInventory.rows.flatMap(operation=>operation.roles),...Object.values(roleComposites).flatMap(realm=>Object.keys(realm.clients[memberRoleClientId() as keyof typeof realm.clients]??{}))])].filter(role=>!role.startsWith('Platform.'));
  const matchingSubject=(alias:string)=>sql`case ${col(alias,'AuthorizationProfileAssignment','subjectKind')}
    when 'user' then app.current_principal_class()='person' and ${col(alias,'AuthorizationProfileAssignment','subjectKey')}=actor.context->>'identityId'
    when 'group' then app.current_principal_class()='person' and actor.context->'groupIds' ? ${col(alias,'AuthorizationProfileAssignment','subjectKey')}
    when 'role' then actor.context->'roles' ? ${col(alias,'AuthorizationProfileAssignment','subjectKey')}
    else false end`;
  const roleExpansions=Object.fromEntries(Object.keys(roleComposites).map(realm=>[realm,Object.fromEntries(knownRoles.map(role=>[role,expandRoleComposites(realm,[role],memberRoleClientId()).filter(role=>!role.startsWith('Platform.'))]))]));
  await sql`
    create or replace function app.authorization_actor() returns jsonb
    language plpgsql stable as $function$
    declare identity uuid; relation uuid; member_roles text[]; group_ids uuid[]; role_keys text[]; held text[]:=array[]::text[];
      role_key text; role_expansions jsonb := ${sql.lit(JSON.stringify(roleExpansions))}::jsonb; realm text; permissions text[];
    begin
      if app.current_principal_class()<>'person' then
        return jsonb_build_object('identityId',null,'userId',app.current_user_id(),'relationId',app.current_relation_id(),'groupIds','[]'::jsonb,
          'roles',to_jsonb(string_to_array(coalesce(current_setting('app.roles',true),''),',')));
      end if;
      select i.id,ir.relation_id,ir.roles,split_part(split_part(i.issuer,'/realms/',2),'/',1)
        into identity,relation,member_roles,realm
        from platform.identity_relations ir join platform.identities i on i.id=ir.identity_id
        where ir.tenant_id=app.current_tenant() and i.id::text=nullif(current_setting('app.audit_identity_id',true),'')
          and i.subject=app.current_user_id()::text and ir.status='linked' and not ir.access_blocked;
      if identity is null then
        return jsonb_build_object('identityId',null,'userId',app.current_user_id(),'relationId',null,'groupIds','[]'::jsonb,'roles','[]'::jsonb);
      end if;
      select coalesce(array_agg(distinct g.id),array[]::uuid[]) into group_ids
        from ${table('RelationGroup')} g join ${table('RelationGroupMembership')} m on m.tenant_id=g.tenant_id and m.relation_group_id=g.id
        where g.tenant_id=app.current_tenant() and m.relation_id=relation and g.status='active' and m.status='active'
          and (m.start_date is null or m.start_date<=current_date) and (m.end_date is null or m.end_date>=current_date);
      if cardinality(group_ids)>256 then group_ids:=array[]::uuid[]; end if;
      role_keys:=coalesce(member_roles,array[]::text[])||array(select gr.role from platform.relation_group_roles gr
        where gr.tenant_id=app.current_tenant() and gr.relation_group_id=any(group_ids));
      foreach role_key in array role_keys loop
        if role_key like 'custom:%' then
          select array_agg(permission) into permissions from platform.organization_access_roles r cross join lateral unnest(r.permissions) permission
            where r.tenant_id=app.current_tenant() and 'custom:'||r.id::text=role_key
              and permission in (select jsonb_array_elements_text(${sql.lit(JSON.stringify(accessPolicy.permissions))}::jsonb));
          if exists(select 1 from platform.organization_access_roles r where r.tenant_id=app.current_tenant() and 'custom:'||r.id::text=role_key) then
            held:=held||array[role_key]||coalesce(permissions,array[]::text[]);
          end if;
        else
          held:=held||array(select jsonb_array_elements_text(coalesce(role_expansions->realm->role_key,'[]'::jsonb)));
        end if;
      end loop;
      return jsonb_build_object('identityId',identity,'userId',app.current_user_id(),'relationId',relation,'groupIds',to_jsonb(group_ids),
        'roles',to_jsonb(array(select distinct value from unnest(held) value)));
    end;
    $function$;
  `.execute(db);
  // Reuse the existing non-login identity resolver for a tenant-fenced boolean FK lookup.
  // It gains no group name/content read and no write privilege.
  const resolver=databaseRole('identityResolver').name;
  await sql`grant usage on schema ${sql.id(entityTableName('RelationGroup').split('.')[0]!)} to ${sql.id(resolver)}`.execute(db);
  await sql`grant select(id,tenant_id,status) on ${table('RelationGroup')} to ${sql.id(resolver)}`.execute(db);
  await sql`drop policy if exists authorization_group_subject_lookup on ${table('RelationGroup')}`.execute(db);
  await sql`create policy authorization_group_subject_lookup on ${table('RelationGroup')} for select to ${sql.id(resolver)} using(tenant_id=app.current_tenant())`.execute(db);
  await sql`
    create or replace function app.authorization_group_exists(group_key text) returns boolean
    language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $function$
    begin
      if not app.has_any_role(array['Organization.Security.Manage']) then return false; end if;
      return exists(select 1 from ${table('RelationGroup')} g where g.tenant_id=app.current_tenant() and g.id::text=group_key and g.status='active');
    end;
    $function$;
    revoke all on function app.authorization_group_exists(text) from public;
    grant execute on function app.authorization_group_exists(text) to ${sql.id(APP_ROLE)};
    alter function app.authorization_group_exists(text) owner to ${sql.id(resolver)};
  `.execute(db);
  const policies=table('AuthorizationOperationPolicy'),assignments=table('AuthorizationProfileAssignment'),profiles=table('AuthorizationProfile'),versions=table('AuthorizationProfileVersion');
  await sql`
    create or replace function app.authorization_rules_for_actor() returns jsonb
    language sql stable as $function$
      with actor as materialized(select app.authorization_actor() as context)
      select jsonb_build_object(
        'actor',actor.context,
        'managedEntities',coalesce((select jsonb_agg(distinct ${col('s','AuthorizationOperationPolicy','entityType')}) from ${policies} s where s.tenant_id=app.current_tenant() and ${col('s','AuthorizationOperationPolicy','managed')}),'[]'::jsonb),
        'states',coalesce((select jsonb_object_agg(${col('s','AuthorizationOperationPolicy','operationId')},jsonb_build_object(
          'entity',i.entity_name,'managed',${col('s','AuthorizationOperationPolicy','managed')},'grantable',coalesce(i.grantable,false),'fields',i.fields,
          'listFields',${col('s','AuthorizationOperationPolicy','listFields')},
          'rules',case when exists(select 1 from ${assignments} direct where direct.tenant_id=app.current_tenant()
            and ${col('direct','AuthorizationProfileAssignment','active')} and ${col('direct','AuthorizationProfileAssignment','profileVersion')} is null and ${col('direct','AuthorizationProfileAssignment','operationId')}=i.id
            and ${matchingSubject('direct')}) then '[null]'::jsonb else coalesce((select case when count(*)>100 then '[]'::jsonb else jsonb_agg(matched.condition) end from (select distinct v.id, policy_row->'row'->${sql.lit(entityColumnName('AuthorizationProfilePolicy','condition'))} as condition
            from ${assignments} a
            join ${versions} v on v.tenant_id=a.tenant_id and v.id=${col('a','AuthorizationProfileAssignment','profileVersion')}
            join ${profiles} p on p.tenant_id=v.tenant_id and p.id=${col('v','AuthorizationProfileVersion','profile')}
            cross join lateral jsonb_array_elements(coalesce(v.snapshot->'head'->'children'->${sql.lit(entityTableName('AuthorizationProfilePolicy').split('.').at(-1)!)},'[]'::jsonb)) policy_row
            where a.tenant_id=app.current_tenant() and (${col('a','AuthorizationProfileAssignment','operationId')} is null or ${col('a','AuthorizationProfileAssignment','operationId')}=i.id) and ${col('a','AuthorizationProfileAssignment','active')} and ${col('p','AuthorizationProfile','active')}
              and v.status='published' and v.snapshot->>'entity'='AuthorizationProfile'
              and v.snapshot->'head'->'row'->>${sql.lit(entityColumnName('AuthorizationProfile','targetEntity'))}=i.entity_name
              and policy_row->'row'->>${sql.lit(entityColumnName('AuthorizationProfilePolicy','operationId'))}=i.id
              and ${matchingSubject('a')} limit 101) matched),'[]'::jsonb) end))
          from ${policies} s left join platform.authorization_operation_inventory i on i.id=${col('s','AuthorizationOperationPolicy','operationId')}
          where s.tenant_id=app.current_tenant()),'{}'::jsonb)) from actor;
    $function$;

    create or replace function app.authorization_requires_lock(operation text, dependencies jsonb) returns boolean
    language sql stable as $function$
      select exists(select 1 from ${policies} s where s.tenant_id=app.current_tenant() and ${col('s','AuthorizationOperationPolicy','managed')}
        and (${col('s','AuthorizationOperationPolicy','operationId')}=operation or dependencies ? ${col('s','AuthorizationOperationPolicy','operationId')}));
    $function$;

    create or replace function app.authorization_entity_managed(entity text) returns boolean
    language sql stable parallel safe as $function$
      select coalesce(nullif(current_setting('app.authorization_rules',true),'')::jsonb->'managedEntities' ? entity, false);
    $function$;

    create or replace function app.authorization_allows(entity text, resource jsonb) returns boolean
    language plpgsql stable as $function$
    declare config jsonb; state jsonb; rule jsonb; actor jsonb; operation text;
    begin
      config := nullif(current_setting('app.authorization_rules',true),'')::jsonb;
      if config is null then config := app.authorization_rules_for_actor(); end if;
      operation := nullif(current_setting('app.audit_operation',true),'');
      state := config->'states'->operation;
      if state->>'entity' is distinct from entity and coalesce(nullif(current_setting('app.audit_read_operations',true),''),'[]')::jsonb ? (entity||'.list') then
        state := config->'states'->(entity||'.list');
      end if;
      if state is null or state->>'entity' is distinct from entity then
        return not coalesce(config->'managedEntities' ? entity,false);
      end if;
      if state->>'managed'='false' then return true; end if;
      if state->>'grantable' is distinct from 'true' then return false; end if;
      actor := config->'actor';
      for rule in select jsonb_array_elements(state->'rules') loop
        if app.authorization_condition_allows(rule,resource,actor,state->'fields') then return true; end if;
      end loop;
      return false;
    exception when others then return false;
    end;
    $function$;
  `.execute(db);
  const policyTableName=entityTableName('AuthorizationOperationPolicy').split('.').at(-1)!;
  await sql`
    create or replace function app.guard_authorization_resource() returns trigger
    language plpgsql as $function$
    begin
      if not app.bypass_rls() and app.authorization_entity_managed(tg_argv[0]) then
        if tg_op<>'INSERT' and not app.authorization_allows(tg_argv[0],to_jsonb(old)) then
          raise exception 'FORBIDDEN: The Operation is not permitted on this record' using errcode='42501';
        end if;
        if tg_op<>'DELETE' and not app.authorization_allows(tg_argv[0],to_jsonb(new)) then
          raise exception 'FORBIDDEN: The resulting record is outside the Operation policy' using errcode='42501';
        end if;
      end if;
      if tg_op='DELETE' then return old; end if;
      return new;
    end;
    $function$;
    create or replace function app.guard_authorization_content() returns trigger
    language plpgsql as $function$
    begin
      if current_user = ${sql.lit(APP_ROLE)} and not app.has_any_role(array['Organization.Security.Manage']) then
        raise exception 'FORBIDDEN: Security management permission required' using errcode='42501';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('osf.authorization:'||app.current_tenant()::text,0));
      if tg_op='DELETE' then return old; end if;
      if tg_table_name=${sql.lit(entityTableName('AuthorizationProfileAssignment').split('.').at(-1)!)} then
       if new.profile_version is null and nullif(new.operation_id,'') is null then
         raise exception 'VALIDATION: Choose a profile version or a direct Operation' using errcode='23514';
       end if;
       if new.active then
        if new.profile_version is null then
          if not exists(select 1 from platform.authorization_operation_inventory i where i.id=new.operation_id and i.grantable) then
            raise exception 'VALIDATION: The direct grant is outside the application ceiling' using errcode='23514';
          end if;
        elsif not exists(select 1 from ${versions} v where v.tenant_id=new.tenant_id and v.id=new.profile_version and v.status='published') then
          raise exception 'VALIDATION: Choose a published profile version in this organization' using errcode='23514';
        end if;
        if new.profile_version is not null and nullif(new.operation_id,'') is not null and not exists(
          select 1 from ${versions} v cross join lateral jsonb_array_elements(coalesce(v.snapshot->'head'->'children'->${sql.lit(entityTableName('AuthorizationProfilePolicy').split('.').at(-1)!)},'[]'::jsonb)) policy_row
          join platform.authorization_operation_inventory i on i.id=new.operation_id and i.grantable
          where v.tenant_id=new.tenant_id and v.id=new.profile_version and v.snapshot->'head'->'row'->>${sql.lit(entityColumnName('AuthorizationProfile','targetEntity'))}=i.entity_name
            and policy_row->'row'->>${sql.lit(entityColumnName('AuthorizationProfilePolicy','operationId'))}=new.operation_id
        ) then
          raise exception 'VALIDATION: The profile has no eligible policy for this Operation' using errcode='23514';
        end if;
        if not (case new.subject_kind
          when 'user' then exists(select 1 from platform.identity_relations member where member.tenant_id=new.tenant_id and member.identity_id::text=new.subject_key and member.status='linked' and not member.access_blocked)
          when 'group' then app.authorization_group_exists(new.subject_key)
          when 'role' then new.subject_key in (select jsonb_array_elements_text(${sql.lit(JSON.stringify(knownRoles))}::jsonb)) or exists(select 1 from platform.organization_access_roles role where role.tenant_id=new.tenant_id and 'custom:'||role.id::text=new.subject_key)
          else false end) then
          raise exception 'VALIDATION: Choose an active subject in this organization' using errcode='23514';
        end if;
      end if;
       end if;
      if tg_table_name=${sql.lit(policyTableName)} then
        if tg_op='UPDATE' and (old.operation_id is distinct from new.operation_id or old.entity_type is distinct from new.entity_type) then
          raise exception 'VALIDATION: Operation identity is immutable' using errcode='23514';
        end if;
        if new.managed and new.list_fields is null then
          select coalesce(jsonb_agg(field.key),'[]'::jsonb) into new.list_fields
            from platform.authorization_operation_inventory i cross join lateral jsonb_each(i.fields) field
            where i.id=new.operation_id and field.value->>'display'='true';
        end if;
        if new.list_fields is not null and (jsonb_typeof(new.list_fields)<>'array' or jsonb_array_length(new.list_fields)>200) then
          raise exception 'VALIDATION: Invalid list projection' using errcode='23514';
        end if;
        if new.list_fields is not null and exists(select 1 from jsonb_array_elements_text(new.list_fields) field
          where field<>'id' and not exists(select 1 from platform.authorization_operation_inventory i where i.id=new.operation_id and i.fields ? field)) then
          raise exception 'VALIDATION: The list projection contains an unavailable field' using errcode='23514';
        end if;
        if not exists(select 1 from platform.authorization_operation_inventory i
          where i.id=new.${sql.id(entityColumnName('AuthorizationOperationPolicy','operationId'))}
            and i.entity_name=new.${sql.id(entityColumnName('AuthorizationOperationPolicy','entityType'))}
            and i.entity_name not like 'Authorization%'
            and (not new.${sql.id(entityColumnName('AuthorizationOperationPolicy','managed'))} or i.grantable)) then
          raise exception 'VALIDATION: Operation is unavailable within the application ceiling' using errcode='23514';
        end if;
        if new.${sql.id(entityColumnName('AuthorizationOperationPolicy','managed'))} and
          (tg_op='INSERT' or not old.${sql.id(entityColumnName('AuthorizationOperationPolicy','managed'))}) and
          not exists(select 1 from ${policies} existing where existing.tenant_id=new.tenant_id
            and existing.${sql.id(entityColumnName('AuthorizationOperationPolicy','entityType'))}=new.${sql.id(entityColumnName('AuthorizationOperationPolicy','entityType'))}
            and existing.${sql.id(entityColumnName('AuthorizationOperationPolicy','managed'))} and existing.id<>new.id) then
          insert into ${policies}(tenant_id,${sql.id(entityColumnName('AuthorizationOperationPolicy','operationId'))},${sql.id(entityColumnName('AuthorizationOperationPolicy','entityType'))},${sql.id(entityColumnName('AuthorizationOperationPolicy','managed'))})
            select new.tenant_id,i.id,i.entity_name,false from platform.authorization_operation_inventory i
            where i.entity_name=new.${sql.id(entityColumnName('AuthorizationOperationPolicy','entityType'))} and i.id<>new.${sql.id(entityColumnName('AuthorizationOperationPolicy','operationId'))}
            on conflict do nothing;
        end if;
      end if;
      return new;
    end;
    $function$;
    create or replace function app.guard_authorization_version() returns trigger
    language plpgsql as $function$
    begin
      if (current_user = ${sql.lit(APP_ROLE)} and not app.has_any_role(array['Organization.Security.Manage'])) or tg_op<>'INSERT' or nullif(current_setting('app.publishing_entity',true),'') is distinct from 'AuthorizationProfile' then
        raise exception 'FORBIDDEN: Authorization profile versions are immutable and must be published' using errcode='42501';
      end if;
      return new;
    end;
    $function$;
  `.execute(db);
  await sql`create unique index if not exists authorization_direct_subject_uidx on ${assignments}(tenant_id,operation_id,subject_kind,subject_key) where profile_version is null and active`.execute(db);
  for(const entity of ['AuthorizationProfile','AuthorizationProfilePolicy','AuthorizationProfileAssignment','AuthorizationOperationPolicy']) {
    const target=table(entity);
    await sql`drop trigger if exists authorization_content_guard on ${target}`.execute(db);
    await sql`create trigger authorization_content_guard before insert or update or delete on ${target} for each row execute function app.guard_authorization_content()`.execute(db);
  }
  await sql`drop trigger if exists authorization_version_guard on ${versions}`.execute(db);
  await sql`create trigger authorization_version_guard before insert or update or delete on ${versions} for each row execute function app.guard_authorization_version()`.execute(db);
}


async function installAuthorizationRowPolicies(db: OpenShapeForgeDatabase) {
  const tables=manifest.tables as unknown as GeneratedCrudTable[];
  const subtypes=((manifest as unknown as {entitySubtypes?:GeneratedCrudTable[]}).entitySubtypes??[]);
  for(const table of tables) {
    const entity=table.source?.authoringEntityName;
    if(!entity || !table.tenantScoped || entity.startsWith('Authorization')) continue;
    const target=sql.id(table.schema,table.table);
    const row=sql.ref(table.table);
    await sql`drop trigger if exists authorization_resource_guard on ${target}`.execute(db);
    await sql`create trigger authorization_resource_guard before insert or update or delete on ${target} for each row execute function app.guard_authorization_resource(${sql.lit(entity)})`.execute(db);

    const checks=[sql`(not (select app.authorization_entity_managed(${sql.lit(entity)})) or app.authorization_allows(${sql.lit(entity)},to_jsonb(${row})))`];
    for(const subtype of subtypes.filter(subtype=>subtype.subtype?.base.table===table.name)) {
      const scope=sql.join(subtype.subtype!.scope.map(scope=>sql`${sql.ref(scope.column)} is not distinct from ${sql.lit(scope.value)}`),sql` and `);
      checks.push(sql`(not (${scope}) or not (select app.authorization_entity_managed(${sql.lit(subtype.source!.authoringEntityName!)})) or app.authorization_allows(${sql.lit(subtype.source!.authoringEntityName!)},to_jsonb(${row})))`);
    }
    const subjectLookup=entity==='RelationGroup'?sql`current_user=${sql.lit(databaseRole('identityResolver').name)} and app.has_any_role(array['Organization.Security.Manage'])`:sql`false`;
    const predicate=sql`app.bypass_rls() or (${subjectLookup}) or (${sql.join(checks,sql` and `)})`;
    await sql`drop policy if exists authorization_profile_scope on ${target}`.execute(db);
    await sql`create policy authorization_profile_scope on ${target} as restrictive for all using (${predicate}) with check (${predicate})`.execute(db);
  }
}
