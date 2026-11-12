// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { databaseRole } from "../database-roles.js";
import { APP_ROLE } from "./app-role.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

const IDENTITY_RESOLVER_ROLE = databaseRole("identityResolver").name;

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
 *     the same reason: a SECURITY DEFINER point lookup owned by the identity
 *     resolver and admitted over two columns, never a list, never a session;
 *   - `max_uses`, when set, is at least one, and `uses` never exceeds it, so
 *     a consumed grant is one whose use count reached its ceiling and
 *     nothing else;
 *   - `failed_attempts` is never negative.
 */
export async function applyCapabilityGrantsMigration(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    grant usage on schema app, platform to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    grant select (id, tenant_id) on platform.capability_grants to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    drop policy if exists capability_grants_tenant_resolution on platform.capability_grants;
    create policy capability_grants_tenant_resolution on platform.capability_grants for select
      to ${sql.id(IDENTITY_RESOLVER_ROLE)} using (true);

    create or replace function app.capability_grant_tenant(grant_id uuid)
    returns uuid
    language sql stable security definer
    set search_path = pg_catalog, pg_temp
    as $fn$
      select g.tenant_id
        from platform.capability_grants g
       where g.id = $1
       limit 1
    $fn$;

    grant create on schema app to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    alter function app.capability_grant_tenant(uuid) owner to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    revoke create on schema app from ${sql.id(IDENTITY_RESOLVER_ROLE)};
    revoke all on function app.capability_grant_tenant(uuid) from public;
    grant execute on function app.capability_grant_tenant(uuid) to ${sql.id(APP_ROLE)};
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
