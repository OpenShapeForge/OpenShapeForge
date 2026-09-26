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

    create or replace function app.current_worker_role() returns text
    language sql stable parallel safe as $$
      select nullif(current_setting('app.worker_role', true), '')
    $$;

    -- Validate the complete action-ACL document before any subject match. A
    -- malformed member must never be mistaken for a valid empty set, because
    -- entities may explicitly choose empty=public for a well-formed ACL.
    create or replace function app.record_permissions_valid(document jsonb)
    returns boolean
    language plpgsql immutable parallel safe
    as $$
    declare
      action_key text;
      subjects jsonb;
      subject_key text;
      entries jsonb;
      entry jsonb;
    begin
      if document is null or jsonb_typeof(document) <> 'object' then
        return false;
      end if;
      for action_key, subjects in select key, value from jsonb_each(document)
      loop
        if action_key not in ('view', 'edit', 'delete')
          or jsonb_typeof(subjects) <> 'object' then
          return false;
        end if;
        for subject_key, entries in select key, value from jsonb_each(subjects)
        loop
          if subject_key not in ('users', 'groups', 'roles')
            or jsonb_typeof(entries) <> 'array' then
            return false;
          end if;
          for entry in select value from jsonb_array_elements(entries)
          loop
            if jsonb_typeof(entry) <> 'string' or entry #>> '{}' = '' then
              return false;
            end if;
          end loop;
        end loop;
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
