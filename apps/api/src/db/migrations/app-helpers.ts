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

    -- WHICH CREDENTIAL of that application authenticated this request:
    -- platform.api_keys.id, written by applyDbSession from the row the store
    -- resolved under tenant-fenced RLS (auth/api-key/store.ts) and from
    -- nowhere else. The integration above outlives rotation and revocation on
    -- purpose, so it cannot answer "is the credential in my hand still
    -- valid"; this can, and app.record_action_principal_live()
    -- (db/migrations/record-actions.ts) is the one caller that asks.
    --
    -- It is an identity, never a secret: the row's primary key, not the
    -- presented token, not its lookup id and not its hash. Empty for every
    -- carrier that is not a resolved API key, which is what makes the fence
    -- a no-op for every existing human and bearer session.
    create or replace function app.current_app_credential() returns uuid
    language sql stable parallel safe as $$
      select nullif(current_setting('app.app_credential_id', true), '')::uuid
    $$;

    -- WHAT KIND of principal the server verified this session to be, written
    -- by applyDbSession from server-sourced facts only (db/session.ts):
    --   person      a verified human - bearer claims that are not a service
    --               account, or any carrier whose identity-Relation link was
    --               read back from platform.identity_relations
    --   application a resolved API-key integration (app.current_app_principal)
    --   service     a verified client-credentials principal with no
    --               integration behind it, organization automation included
    --   unknown     anything else, including a carrier that states nothing
    --
    -- The named-action axis matches a subject kind against this and nothing
    -- else: a person subject is satisfiable only by person, an integrations
    -- subject only by application. So a service account holding the same role
    -- as a person cannot acquire that person's action, an unclassified session
    -- holds no action at all, and none of this touches how view/edit/delete
    -- or any existing role check behaves.
    create or replace function app.current_principal_class() returns text
    language sql stable parallel safe as $$
      select coalesce(nullif(current_setting('app.principal_class', true), ''), 'unknown')
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
        -- A person subject is a PERSON's. A session the server classified as
        -- a service or could not classify at all holds nothing here, however
        -- many of the named roles it carries.
        when app.current_principal_class() = 'person' then
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
        -- The verified application, never a claim or a header; null for every
        -- other carrier, and ? null is null, hence a denial.
        when app.current_principal_class() = 'application' then
          coalesce(
            (subjects -> 'integrations') ? app.current_app_principal()::text,
            false
          )
        else false
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
