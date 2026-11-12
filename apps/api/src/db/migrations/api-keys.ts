// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { databaseRole } from "../database-roles.js";
import { APP_ROLE } from "./app-role.js";

const IDENTITY_RESOLVER_ROLE = databaseRole("identityResolver").name;

/**
 * Row-level security for the two platform tables that carry a tenant_id but
 * used to have no policy: `platform.api_keys` and
 * `platform.system_bypass_audit`. The restricted runtime role holds blanket
 * DML on every table in a manifest-covered schema (app-role.ts), so a
 * policyless table is fully readable and writable from any raw-SQL path an
 * ordinary tenant session can reach — a key row of another tenant included.
 *
 * api_keys: tenant-fenced like every other platform.* row. The one read that
 * happens BEFORE a tenant is known — authentication resolving a presented
 * credential — goes through `app.api_key_tenant(lookup_id)`, a SECURITY
 * DEFINER point lookup owned by the identity resolver (the same shape as
 * `app.tenant_for_keycloak_organization` and `app.capability_grant_tenant`):
 * it answers ONE tenant id for ONE lookup id, never a list, and the store
 * then opens an ordinary tenant-fenced session for the secret comparison and
 * everything after (auth/api-key/store.ts).
 *
 * system_bypass_audit: an append-only trail. Anyone may INSERT (the failure
 * row in db/session.ts is written outside any session, after the transaction
 * that failed); only the audited bypass session may SELECT it or UPDATE it
 * (the completion write of withSystemSession sets ended_at + succeeded on the
 * row it opened); nothing may DELETE — no policy grants it, and app-role.ts
 * revokes the privilege from the runtime role on every migrate.
 */
export async function applyApiKeysMigration(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    -- A point lookup, owned by the non-login identity resolver and admitted
    -- by a role-specific read policy over two columns. No bypass setting is
    -- raised: the runtime role cannot raise one (db/rls-bypass.ts), and a
    -- definer function needs none.
    grant usage on schema app, platform to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    grant select (tenant_id, lookup_id) on platform.api_keys to ${sql.id(IDENTITY_RESOLVER_ROLE)};

    create or replace function app.api_key_tenant(lookup text) returns uuid
    language sql stable security definer
    set search_path = pg_catalog, pg_temp
    as $fn$
      select k.tenant_id
        from platform.api_keys k
       where k.lookup_id = $1
       limit 1
    $fn$;

    grant create on schema app to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    alter function app.api_key_tenant(text) owner to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    revoke create on schema app from ${sql.id(IDENTITY_RESOLVER_ROLE)};
    revoke all on function app.api_key_tenant(text) from public;
    grant execute on function app.api_key_tenant(text) to ${sql.id(APP_ROLE)};

    alter table platform.api_keys enable row level security;
    alter table platform.api_keys force row level security;

    drop policy if exists api_keys_tenant_isolation on platform.api_keys;
    create policy api_keys_tenant_isolation on platform.api_keys
      using (app.bypass_rls() or tenant_id = app.current_tenant())
      with check (app.bypass_rls() or tenant_id = app.current_tenant());
    drop policy if exists api_keys_tenant_resolution on platform.api_keys;
    create policy api_keys_tenant_resolution on platform.api_keys for select
      to ${sql.id(IDENTITY_RESOLVER_ROLE)} using (true);

    alter table platform.system_bypass_audit enable row level security;
    alter table platform.system_bypass_audit force row level security;

    drop policy if exists system_bypass_audit_read on platform.system_bypass_audit;
    create policy system_bypass_audit_read on platform.system_bypass_audit
      for select using (app.bypass_rls());
    drop policy if exists system_bypass_audit_append on platform.system_bypass_audit;
    create policy system_bypass_audit_append on platform.system_bypass_audit
      for insert with check (true);
    drop policy if exists system_bypass_audit_complete on platform.system_bypass_audit;
    create policy system_bypass_audit_complete on platform.system_bypass_audit
      for update using (app.bypass_rls()) with check (app.bypass_rls());
  `.execute(db);
}
