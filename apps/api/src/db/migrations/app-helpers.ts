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

    create or replace function app.has_scope(target text) returns boolean
    language sql stable parallel safe as $$
      select current_setting('app.scope', true) = target
    $$;

    create or replace function app.bypass_rls() returns boolean
    language sql stable parallel safe as $$
      select coalesce(current_setting('app.bypass_rls', true) = 'true', false)
    $$;

    create or replace function app.current_worker_role() returns text
    language sql stable parallel safe as $$
      select nullif(current_setting('app.worker_role', true), '')
    $$;

    -- The one registry read that happens BEFORE a session has a tenant: turning
    -- a verified Keycloak Organization membership into the tenant it belongs
    -- to (apps/api src/auth/identity.ts). platform.tenants is fenced by
    -- app.bypass_rls() OR id = app.current_tenant(), and a session that is
    -- still resolving its tenant satisfies neither, so this function carries
    -- the bypass GUC only for its lookup and restores the caller's value.
    -- Function-level SET on a custom GUC requires superuser/parameter grants
    -- unavailable to managed-database migrators. The exception block rolls
    -- back the local setting if the lookup raises; normal return restores it
    -- explicitly. Configuration mutation makes this VOLATILE/PARALLEL UNSAFE.
    --
    -- Deliberately a point lookup and not a registry read: it answers ONE
    -- tenant id for ONE (realm, organization id) pair the caller already
    -- proved membership of through a signed token, never a list. It is not an
    -- operator bypass session and writes no system_bypass_audit row for the
    -- same reason withCredentialResolutionSession does not — it grants no
    -- cross-tenant reach. plpgsql rather than sql so the body is not resolved
    -- against platform.tenants at definition time: this helper step runs
    -- before the generated schema step on a fresh database.
    create or replace function app.tenant_for_keycloak_organization(
      realm text,
      organization_id text
    ) returns uuid
    language plpgsql volatile parallel unsafe
    as $$
    declare
      previous_bypass text := current_setting('app.bypass_rls', true);
      tenant_id uuid;
    begin
      perform set_config('app.bypass_rls', 'true', true);
      tenant_id := (
        select t.id
          from platform.tenants t
         where t.keycloak_realm = realm
           and t.keycloak_organization_id = organization_id
         limit 1
      );
      perform set_config('app.bypass_rls', coalesce(previous_bypass, ''), true);
      return tenant_id;
    exception when others then
      raise;
    end
    $$;
  `.execute(db);
}
