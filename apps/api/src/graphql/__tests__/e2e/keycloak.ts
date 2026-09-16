// SPDX-License-Identifier: BUSL-1.1

import { sql, type Kysely } from "kysely";
import type { DB } from "../../../generated/db/types.js";

type KeycloakTokenStore = {
  defaultToken: Promise<string | null> | null;
  rolelessToken: Promise<string | null> | null;
  tokens: Map<string, Promise<string | null>>;
};

/**
 * Give the real-realm identities used by transport tests a tenant-owned
 * Relation. Production correctly refuses a valid realm token that the tenant
 * neither knows nor invited; these suites test bearer verification and role
 * enforcement, so membership is test setup rather than their subject.
 */
export async function seedKeycloakTokenPeople(
  db: Kysely<DB>,
  tokens: readonly (string | null)[],
): Promise<void> {
  for (const token of tokens) {
    if (!token) continue;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    ) as {
      tid?: string;
      email?: string;
      name?: string;
      preferred_username?: string;
    };
    if (!claims.tid || !claims.email) continue;
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

/** Token for a user that holds realm roles (acme-directie by default). */
export function getKeycloakToken(): Promise<string | null> {
  const username = process.env.E2E_KEYCLOAK_USERNAME ?? "acme-directie";
  store.defaultToken ??= fetchKeycloakToken(
    username,
    process.env.E2E_KEYCLOAK_PASSWORD ?? passwordFor(username),
  );
  return store.defaultToken;
}

/** Token for an enabled user without realm roles, proving bearer role denial. */
export function getRolelessKeycloakToken(): Promise<string | null> {
  const username = process.env.E2E_KEYCLOAK_NOACCESS_USERNAME ?? "acme-noaccess";
  store.rolelessToken ??= fetchKeycloakToken(
    username,
    process.env.E2E_KEYCLOAK_NOACCESS_PASSWORD ?? passwordFor(username),
  );
  return store.rolelessToken;
}
