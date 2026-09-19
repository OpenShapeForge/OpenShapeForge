// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

/**
 * The invariants of `platform.capability_grants` (declared in
 * packages/compiler/config/platform-schema.yaml, resolved by
 * operations/capability-grants.ts) that the manifest cannot express:
 *
 *   - the one registry read that happens BEFORE a grant session has a
 *     tenant: `app.capability_grant_tenant(grant_id)` answers the tenant of
 *     ONE grant row so the resolver can open an ordinary tenant-fenced
 *     session and do everything else — the secret comparison, the expiry,
 *     revocation and lock checks, the attempt bookkeeping — under RLS. It
 *     is the same shape as `app.tenant_for_keycloak_organization` and for
 *     the same reason: a point lookup carrying the bypass GUC only for its
 *     own statement, never a list, never a session;
 *   - `max_uses`, when set, is at least one, and `uses` never exceeds it, so
 *     a consumed grant is one whose use count reached its ceiling and
 *     nothing else;
 *   - `failed_attempts` is never negative.
 */
export async function applyCapabilityGrantsMigration(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    create or replace function app.capability_grant_tenant(grant_id uuid)
    returns uuid
    language plpgsql volatile parallel unsafe
    as $$
    declare
      previous_bypass text := current_setting('app.bypass_rls', true);
      found_tenant uuid;
    begin
      perform set_config('app.bypass_rls', 'true', true);
      found_tenant := (
        select g.tenant_id
          from platform.capability_grants g
         where g.id = grant_id
         limit 1
      );
      perform set_config('app.bypass_rls', coalesce(previous_bypass, ''), true);
      return found_tenant;
    exception when others then
      raise;
    end
    $$;
  `.execute(db);
  await ensureCheckConstraint(db, {
    table: "platform.capability_grants",
    name: "capability_grants_max_uses_check",
    expression: "max_uses is null or (max_uses >= 1 and uses <= max_uses)",
  });
  await ensureCheckConstraint(db, {
    table: "platform.capability_grants",
    name: "capability_grants_failed_attempts_check",
    expression: "failed_attempts >= 0",
  });
}
