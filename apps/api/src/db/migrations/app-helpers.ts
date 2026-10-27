// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Creates the `app` schema and the STABLE SQL functions used by every
 * Row-Level Security policy in the platform. Wrapping `current_setting`
 * calls in STABLE PARALLEL SAFE functions lets the planner evaluate them
 * once per query (in InitPlan) instead of once per row, which is the
 * load-bearing assumption for the multi-axis RLS design.
 *
 * Must run before any migration that defines a policy referencing these
 * helpers (see apps/api/src/db/migrate.ts).
 */
export async function applyAppHelpersMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create schema if not exists app;

    create or replace function app.current_tenant() returns uuid
    language sql stable parallel safe as $$
      select nullif(current_setting('app.tenant_id', true), '')::uuid
    $$;

    create or replace function app.current_user_id() returns uuid
    language sql stable parallel safe as $$
      select nullif(current_setting('app.user_id', true), '')::uuid
    $$;

    -- The Relation the session acts as (identity.actingParty), written by
    -- applyDbSession from the verified identity link. Owner-axis policies of
    -- person-owned records compare against it (rowAccess.owner.session).
    create or replace function app.current_relation_id() returns uuid
    language sql stable parallel safe as $$
      select nullif(current_setting('app.relation_id', true), '')::uuid
    $$;

    create or replace function app.current_groups() returns uuid[]
    language sql stable parallel safe as $$
      select case
        when nullif(current_setting('app.user_groups', true), '') is null then array[]::uuid[]
        else string_to_array(current_setting('app.user_groups', true), ',')::uuid[]
      end
    $$;

    -- Group-expansion readers for authorization.rowAccess.group.expand. Each
    -- reads a GUC populated ONCE per session in applyDbSession (session.ts):
    --   app.current_groups()           → app.user_groups          (descendants)
    --   app.current_groups_exact()     → app.user_groups_exact    (exact)
    --   app.current_groups_ancestors() → app.user_groups_ancestors (ancestors)
    -- The RLS policy emitted by the compiler selects the reader by expand mode
    -- and compares "col" = ANY(reader()). Same STABLE PARALLEL SAFE shape as
    -- current_groups() so the planner hoists it into InitPlan.
    create or replace function app.current_groups_exact() returns uuid[]
    language sql stable parallel safe as $$
      select case
        when nullif(current_setting('app.user_groups_exact', true), '') is null then array[]::uuid[]
        else string_to_array(current_setting('app.user_groups_exact', true), ',')::uuid[]
      end
    $$;

    create or replace function app.current_groups_ancestors() returns uuid[]
    language sql stable parallel safe as $$
      select case
        when nullif(current_setting('app.user_groups_ancestors', true), '') is null then array[]::uuid[]
        else string_to_array(current_setting('app.user_groups_ancestors', true), ',')::uuid[]
      end
    $$;

    -- Active domain RelationGroup memberships are independent from Keycloak
    -- group paths and the platform org-unit hierarchy above. The application
    -- resolves them from the verified identity↔Relation link on every request
    -- and writes only that server-derived set to this dedicated GUC.
    create or replace function app.current_relation_groups() returns uuid[]
    language sql stable parallel safe as $$
      select case
        when nullif(current_setting('app.relation_group_ids', true), '') is null then array[]::uuid[]
        else string_to_array(current_setting('app.relation_group_ids', true), ',')::uuid[]
      end
    $$;

    create or replace function app.has_scope(target text) returns boolean
    language sql stable parallel safe as $$
      select current_setting('app.scope', true) = target
    $$;

    create or replace function app.bypass_rls() returns boolean
    language sql stable parallel safe as $$
      select coalesce(current_setting('app.bypass_rls', true) = 'true', false)
    $$;

    -- Whether the session holds any of the roles; the compiler's owner-axis
    -- read policies (authorization.ownerAxis) call it with the role names the
    -- manifest carries.
    create or replace function app.has_any_role(candidates text[]) returns boolean
    language sql stable
    as $$ select app.bypass_rls() or coalesce(string_to_array(current_setting('app.roles', true), ',') && candidates, false) $$;

    -- The APPLICATION this session acts as, written by applyDbSession from the
    -- verified API-key integration row and from nowhere else (db/session.ts,
    -- auth/api-key/resolve.ts). Empty for every person, every direct bearer
    -- service account, every trusted-context bundle, every capability grant
    -- and every control session, so a record-action policy that names an
    -- integration matches nobody on those carriers. Deliberately NOT part of
    -- any generated row-scope policy: holding an action on a record never
    -- makes the record readable.
    create or replace function app.current_app_principal() returns uuid
    language sql stable parallel safe as $$
      select nullif(current_setting('app.app_principal_id', true), '')::uuid
    $$;

    create or replace function app.current_worker_role() returns text
    language sql stable parallel safe as $$
      select nullif(current_setting('app.worker_role', true), '')
    $$;

    -- One subject set: {users,groups,roles} and, inside the named-action axis
    -- only, {integrations}. integrations is refused on view/edit/delete by
    -- construction — an application principal can never be named for the
    -- permissions that expose or change the record itself, only for a named
    -- action the entity declared.
    create or replace function app.record_subject_sets_valid(
      sets jsonb,
      allow_integrations boolean
    ) returns boolean
    language plpgsql immutable parallel safe
    as $$
    declare
      subject_key text;
      entries jsonb;
      entry jsonb;
    begin
      if sets is null or jsonb_typeof(sets) <> 'object' then
        return false;
      end if;
      for subject_key, entries in select key, value from jsonb_each(sets)
      loop
        if jsonb_typeof(entries) <> 'array' then
          return false;
        end if;
        if subject_key not in ('users', 'groups', 'roles')
          and not (allow_integrations and subject_key = 'integrations') then
          return false;
        end if;
        for entry in select value from jsonb_array_elements(entries)
        loop
          if jsonb_typeof(entry) <> 'string' or entry #>> '{}' = '' then
            return false;
          end if;
        end loop;
      end loop;
      return true;
    end
    $$;

    -- Validate the complete record-ACL document before any subject match. A
    -- malformed member must never be mistaken for a valid empty set, because
    -- entities may explicitly choose empty=public for a well-formed ACL.
    --
    -- Members: the three fixed permissions, plus an optional actions object
    -- keyed by the action names the entity declared. An action name is a
    -- lowerCamel identifier and may never restate view/edit/delete, so the two
    -- axes cannot be confused for one another in storage or in a predicate.
    create or replace function app.record_permissions_valid(document jsonb)
    returns boolean
    language plpgsql immutable parallel safe
    as $$
    declare
      member_key text;
      member jsonb;
      action_name text;
      subjects jsonb;
    begin
      if document is null or jsonb_typeof(document) <> 'object' then
        return false;
      end if;
      for member_key, member in select key, value from jsonb_each(document)
      loop
        if member_key = 'actions' then
          if jsonb_typeof(member) <> 'object' then
            return false;
          end if;
          for action_name, subjects in select key, value from jsonb_each(member)
          loop
            if action_name !~ '^[a-z][A-Za-z0-9]*$'
              or action_name in ('view', 'edit', 'delete')
              or not app.record_subject_sets_valid(subjects, true) then
              return false;
            end if;
          end loop;
        elsif member_key in ('view', 'edit', 'delete') then
          if not app.record_subject_sets_valid(member, false) then
            return false;
          end if;
        else
          return false;
        end if;
      end loop;
      return true;
    end
    $$;

    create or replace function app.record_permission_subject_allows(
      subjects jsonb,
      empty_is_public boolean
    ) returns boolean
    language sql stable parallel safe
    as $$
      select case
        when jsonb_array_length(coalesce(subjects -> 'users', '[]'::jsonb))
           + jsonb_array_length(coalesce(subjects -> 'groups', '[]'::jsonb))
           + jsonb_array_length(coalesce(subjects -> 'roles', '[]'::jsonb)) = 0
          then empty_is_public
        else
          coalesce((subjects -> 'users') ? app.current_user_id()::text, false)
          or coalesce(
            (subjects -> 'roles') ?| string_to_array(
              coalesce(current_setting('app.roles', true), ''), ','
            ),
            false
          )
          or coalesce(
            (subjects -> 'groups') ?| array(
              select group_id::text from unnest(app.current_relation_groups()) as group_id
            ),
            false
          )
      end
    $$;

    -- Edit and delete deliberately include view. This is the canonical
    -- action meaning; SQL verbs cannot express it because an archive action is
    -- physically an UPDATE but semantically requires delete permission.
    create or replace function app.record_permission_allows(
      document jsonb,
      action text,
      empty_is_public boolean
    ) returns boolean
    language sql stable parallel safe
    as $$
      select case
        when action is null or action not in ('view', 'edit', 'delete')
          or not app.record_permissions_valid(document) then false
        when action = 'view' then
          app.record_permission_subject_allows(
            coalesce(document -> 'view', '{}'::jsonb), empty_is_public
          )
        else
          app.record_permission_subject_allows(
            coalesce(document -> 'view', '{}'::jsonb), empty_is_public
          )
          and app.record_permission_subject_allows(
            coalesce(document -> action, '{}'::jsonb), empty_is_public
          )
      end
    $$;

    -- A named action's subject set. INDEPENDENT of view/edit/delete in both
    -- directions: holding view grants no action, and holding an action
    -- grants no view. An empty or absent set is a DENIAL whatever the entity
    -- authored for empty — the empty=public reading applies to the three
    -- fixed permissions only, so a record that says nothing about an action
    -- says no.
    create or replace function app.record_action_subject_allows(subjects jsonb)
    returns boolean
    language sql stable
    as $$
      select case
        when not app.record_subject_sets_valid(subjects, true) then false
        when jsonb_array_length(coalesce(subjects -> 'users', '[]'::jsonb))
           + jsonb_array_length(coalesce(subjects -> 'groups', '[]'::jsonb))
           + jsonb_array_length(coalesce(subjects -> 'roles', '[]'::jsonb))
           + jsonb_array_length(coalesce(subjects -> 'integrations', '[]'::jsonb)) = 0
          then false
        else
          coalesce((subjects -> 'users') ? app.current_user_id()::text, false)
          or coalesce(
            (subjects -> 'roles') ?| string_to_array(
              coalesce(current_setting('app.roles', true), ''), ','
            ),
            false
          )
          or coalesce(
            (subjects -> 'groups') ?| array(
              select group_id::text from unnest(app.current_relation_groups()) as group_id
            ),
            false
          )
          -- The verified application, never a claim or a header; null for
          -- every other carrier, and ? null is null, hence a denial.
          or coalesce(
            (subjects -> 'integrations') ? app.current_app_principal()::text,
            false
          )
      end
    $$;

    -- Does the current session hold action on ONE row of ONE table?
    --
    -- This exists because a named action must be authorizable WITHOUT making
    -- the record readable. The generated row-scope policy gates SELECT on the
    -- record's view permission and stays exactly as it was, so an
    -- application that holds only start cannot see the row — including
    -- through this check, if it were an ordinary read. The statement below
    -- therefore raises the bypass GUC for its own single point lookup and
    -- lowers it again, the same shape as app.api_key_tenant: it answers ONE
    -- boolean about ONE row and discloses nothing else. An error inside the
    -- lookup either aborts the caller's transaction or rolls the setting back
    -- with the handler's subtransaction, so the bypass cannot outlive the
    -- statement it was raised for. This function is VOLATILE and is never
    -- referenced by a policy, so no STABLE policy helper can observe or cache
    -- the raised value.
    --
    -- Every identifier comes from the compiled manifest (the entity's table,
    -- its ACL column, its primary key), never from request input, and is
    -- rendered through %I/regclass so a hostile name could at worst name a
    -- column that does not exist. The tenant is read from the session rather
    -- than accepted as an argument, and tenant_id is the manifest's tenant
    -- column on every tenant-scoped table; the caller refuses an entity
    -- without one before reaching here.
    create or replace function app.record_action_allows(
      target regclass,
      acl_column text,
      key_column text,
      key_is_uuid boolean,
      record_key text,
      subtype_scope jsonb,
      action text
    ) returns boolean
    language plpgsql volatile parallel unsafe
    as $$
    declare
      tenant uuid := app.current_tenant();
      previous_bypass text;
      statement text;
      document jsonb;
    begin
      if action is null or action !~ '^[a-z][A-Za-z0-9]*$'
        or action in ('view', 'edit', 'delete') then
        return false;
      end if;
      if tenant is null or target is null or acl_column is null
        or key_column is null or record_key is null or record_key = '' then
        return false;
      end if;
      if key_is_uuid and record_key !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return false;
      end if;
      -- An ordinary data table, never a catalog, a view or a toast relation.
      if not exists (
        select 1
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where c.oid = target
           and c.relkind in ('r', 'p')
           and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      ) then
        return false;
      end if;

      statement := format(
        'select t.%I from %s as t where t.%I %s and t.tenant_id = $2'
          || ' and to_jsonb(t) @> $3 limit 1',
        acl_column,
        target,
        key_column,
        case when key_is_uuid then '= $1::uuid' else '::text = $1' end
      );

      previous_bypass := current_setting('app.bypass_rls', true);
      perform set_config('app.bypass_rls', 'true', true);
      begin
        execute statement
           into document
          using record_key, tenant, coalesce(subtype_scope, '{}'::jsonb);
      exception when others then
        perform set_config('app.bypass_rls', coalesce(previous_bypass, ''), true);
        raise;
      end;
      perform set_config('app.bypass_rls', coalesce(previous_bypass, ''), true);

      -- An absent row, a malformed document and an unnamed action are one
      -- answer: no.
      if document is null or not app.record_permissions_valid(document) then
        return false;
      end if;
      return app.record_action_subject_allows(document -> 'actions' -> action);
    end
    $$;

    -- The body is replaced, privilege-scoped and transferred to the dedicated
    -- identity-resolver role by identity-link.ts after the generated registry
    -- tables exist. Keeping this early placeholder preserves migration order:
    -- callers and later invariant DDL can rely on the function name existing
    -- without resolving platform.tenants on a fresh database yet.
    create or replace function app.tenant_for_keycloak_organization(
      realm text,
      organization_id text
    ) returns uuid
    language plpgsql stable parallel safe
    as $$
    begin
      raise exception 'identity registry lookup is not initialized';
    end
    $$;
  `.execute(db);
}
