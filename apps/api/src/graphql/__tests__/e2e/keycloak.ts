// SPDX-License-Identifier: BUSL-1.1

import { sql, type Kysely } from "kysely";
import type { DB } from "../../../generated/db/types.js";

type KeycloakTokenStore = {
  defaultToken: Promise<string | null> | null;
  rolelessToken: Promise<string | null> | null;
  tokens: Map<string, Promise<string | null>>;
};

type TokenPersonClaims = {
  iss?: string;
  sub?: string;
  tid?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
};

function claimsOf(token: string): TokenPersonClaims {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as TokenPersonClaims;
}

/**
 * The organization roles the tenant records for a realm test user: the
 * audience client's roles as the dev realm assigns them to that user. A
 * person's session never reads `resource_access` (auth/person-roles.ts); this
 * is what `seedKeycloakTokenPeople` writes onto the membership row instead,
 * so the dev realm's `users[].clientRoles` keep meaning "what this test
 * identity may do in its tenant".
 */
export function membershipRolesOf(token: string): string[] {
  const audience = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE ?? "erp-provider";
  return [...new Set(claimsOf(token).resource_access?.[audience]?.roles ?? [])].sort();
}

/**
 * Give the real-realm identities used by transport tests a tenant-owned
 * Relation, a LINKED membership row and the roles above. Production
 * correctly refuses a valid realm token that the tenant neither knows nor
 * invited, and grants nothing from the token's client roles; these suites
 * test bearer verification and role enforcement, so membership and its
 * roles are test setup rather than their subject.
 */
export async function seedKeycloakTokenPeople(
  db: Kysely<DB>,
  tokens: readonly (string | null)[],
): Promise<void> {
  for (const token of tokens) {
    if (!token) continue;
    const claims = claimsOf(token);
    if (!claims.tid || !claims.email || !claims.iss || !claims.sub) continue;
    const displayName = claims.name ?? claims.preferred_username ?? claims.email;
    await sql`
      insert into platform.tenants (id, slug, name, status)
      values (
        ${claims.tid},
        ${`e2e-realm-${claims.tid}`},
        ${`E2E realm tenant ${claims.tid}`},
        'active'
      )
      on conflict (id) do nothing
    `.execute(db);
    await sql`
      with created as (
        insert into erp.relations (tenant_id, display_name, relation_type, status)
        select ${claims.tid}, ${displayName}, 'person', 'active'
        where not exists (
          select 1
          from erp.contact_details cd
          where cd.tenant_id = ${claims.tid}
            and cd.type = 'email'
            and lower(cd.value) = lower(${claims.email})
        )
        returning id, tenant_id
      )
      insert into erp.contact_details (tenant_id, relation_id, type, value, is_primary)
      select tenant_id, id, 'email', ${claims.email}, true from created
    `.execute(db);
    const roles = membershipRolesOf(token);
    await sql`
      insert into platform.identities (issuer, subject, email, display_name)
      values (${claims.iss}, ${claims.sub}, ${claims.email}, ${displayName})
      on conflict (issuer, subject) do nothing
    `.execute(db);
    await sql`
      insert into platform.identity_relations
        (identity_id, tenant_id, status, relation_id, linked_at, linked_by, roles)
      select i.id, ${claims.tid}, 'linked', r.id, now(), 'e2e-seed',
             (select coalesce(array_agg(value), '{}'::text[])
                from jsonb_array_elements_text(${roles}::jsonb))
        from platform.identities i
        join erp.contact_details cd
          on cd.tenant_id = ${claims.tid} and cd.type = 'email' and lower(cd.value) = lower(${claims.email})
        join erp.relations r on r.id = cd.relation_id
       where i.issuer = ${claims.iss} and i.subject = ${claims.sub}
       limit 1
      on conflict (identity_id, tenant_id) do update
        set status = 'linked',
            relation_id = excluded.relation_id,
            linked_at = coalesce(platform.identity_relations.linked_at, now()),
            linked_by = coalesce(platform.identity_relations.linked_by, 'e2e-seed'),
            roles = excluded.roles,
            updated_at = now()
    `.execute(db);
  }
}

const store = ((globalThis as Record<string, unknown>).__openshapeforgeE2EKeycloak ??= {
  defaultToken: null,
  rolelessToken: null,
  tokens: new Map(),
}) as KeycloakTokenStore;

async function fetchKeycloakToken(
  username: string,
  password: string,
): Promise<string | null> {
  const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  if (!issuer) return null;
  try {
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: process.env.E2E_KEYCLOAK_CLIENT_ID ?? "openshapeforge-gateway",
        client_secret: process.env.E2E_KEYCLOAK_CLIENT_SECRET ?? "dev-secret",
        username,
        password,
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

/** Resolve the committed dev password or the deployment-specific e2e value. */
function passwordFor(username: string): string {
  const key = `E2E_USER_PASSWORD_${username.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return process.env[key] ?? "test";
}

/** Memoized token for any seeded realm user. */
export function keycloakTokenFor(
  username: string,
  password = passwordFor(username),
): Promise<string | null> {
  let token = store.tokens.get(username);
  if (!token) {
    token = fetchKeycloakToken(username, password);
    store.tokens.set(username, token);
  }
  return token;
}

/** Token for the neutral full-access test identity. */
export function getKeycloakToken(): Promise<string | null> {
  const username = process.env.E2E_KEYCLOAK_USERNAME ?? "tenant-a-admin";
  store.defaultToken ??= fetchKeycloakToken(
    username,
    process.env.E2E_KEYCLOAK_PASSWORD ?? passwordFor(username),
  );
  return store.defaultToken;
}

/** Token for an enabled user without realm roles, proving bearer role denial. */
export function getRolelessKeycloakToken(): Promise<string | null> {
  const username = process.env.E2E_KEYCLOAK_NOACCESS_USERNAME ?? "tenant-a-no-access";
  store.rolelessToken ??= fetchKeycloakToken(
    username,
    process.env.E2E_KEYCLOAK_NOACCESS_PASSWORD ?? passwordFor(username),
  );
  return store.rolelessToken;
}
