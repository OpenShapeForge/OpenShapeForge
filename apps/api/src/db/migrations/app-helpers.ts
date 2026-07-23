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
  `.execute(db);
}
