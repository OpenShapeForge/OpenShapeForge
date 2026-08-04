// SPDX-License-Identifier: BUSL-1.1
/**
 * Reading a presented credential back to the integration it names.
 *
 * Two reads, in this order and for this reason:
 *
 *   1. `platform.api_keys` by `lookup_id`. This table carries no RLS policy —
 *      the tenant is an OUTPUT of authentication, so there is no tenant context
 *      to enforce yet (see platform-schema.yaml for the full argument). It holds
 *      only what authentication needs.
 *   2. `platform.api_key_integrations` by primary key, inside
 *      `withCredentialResolutionSession` — RLS ON, scoped to the tenant step 1
 *      just produced. The client secret and the integration's state never leave
 *      that boundary.
 *
 * Nothing here decides whether the caller is authorized; it decides whether the
 * credential is real, live, and whose. Role resolution happens against Keycloak
 * afterwards.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withCredentialResolutionSession } from "../../db/session.js";
import type { StoredSecret } from "../../platform/secrets.js";
import { secretMatches } from "./format.js";

export type ResolvedApiKey = {
  keyId: string;
  tenantId: string;
  integrationId: string;
  /** null means "whatever the integration's service account holds". */
  roleSubset: string[] | null;
  keycloakClientId: string;
  clientSecret: StoredSecret;
};

/** Why a credential did not resolve. Never returned to the caller verbatim. */
export type ApiKeyRejection =
  | "unknown"
  | "bad-secret"
  | "revoked"
  | "expired"
  | "integration-unavailable";

export type ApiKeyLookupResult =
  | { ok: true; key: ResolvedApiKey }
  | { ok: false; reason: ApiKeyRejection };

type KeyRow = {
  id: string;
  tenant_id: string;
  integration_id: string;
  secret_hash: string;
  role_subset: unknown;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

type IntegrationRow = {
  keycloak_client_id: string;
  status: string;
  client_secret_ciphertext: string | null;
  client_secret_key_id: string | null;
  client_secret_algorithm: string | null;
};

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * A stored `role_subset` must be an array of non-empty strings or nothing. A
 * malformed value is treated as "no subset recorded" rather than as an empty
 * subset: an empty array would silently authorize nothing and read as a
 * mysterious 403, while the honest reading of corrupt data is that no narrowing
 * was expressed.
 */
function parseRoleSubset(value: unknown): string[] | null {
  const raw = typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(raw)) return null;
  const roles = raw.filter(
    (role): role is string => typeof role === "string" && role.trim().length > 0,
  );
  return roles.length > 0 ? roles : null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function resolveApiKey(
  db: OpenShapeForgeDatabase,
  lookupId: string,
  secret: string,
  now: Date = new Date(),
): Promise<ApiKeyLookupResult> {
  const keyResult = await sql<KeyRow>`
    select id, tenant_id, integration_id, secret_hash, role_subset, expires_at, revoked_at
      from platform.api_keys
     where lookup_id = ${lookupId}
     limit 1
  `.execute(db);

  const row = keyResult.rows[0];
  // Compare against a decoy hash when the lookup missed, so an unknown key and
  // a wrong secret cost the same. Without this, response time distinguishes
  // "this lookup id exists" from "it does not" — an enumeration oracle over a
  // column an attacker can otherwise only guess.
  if (!row) {
    secretMatches(secret, "0".repeat(64));
    return { ok: false, reason: "unknown" };
  }

  if (!secretMatches(secret, row.secret_hash)) {
    return { ok: false, reason: "bad-secret" };
  }

  if (asDate(row.revoked_at) !== null) {
    return { ok: false, reason: "revoked" };
  }

  const expiresAt = asDate(row.expires_at);
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const integration = await withCredentialResolutionSession(db, row.tenant_id, async (trx) => {
    const result = await sql<IntegrationRow>`
      select keycloak_client_id, status,
             client_secret_ciphertext, client_secret_key_id, client_secret_algorithm
        from platform.api_key_integrations
       where id = ${row.integration_id}
       limit 1
    `.execute(trx);
    return result.rows[0];
  });

  // 'pending' means provisioning never finished; 'disabled' means the customer
  // turned the whole integration off. Both are the same answer to the holder.
  if (
    !integration ||
    integration.status !== "active" ||
    !integration.client_secret_ciphertext ||
    !integration.client_secret_key_id ||
    !integration.client_secret_algorithm
  ) {
    return { ok: false, reason: "integration-unavailable" };
  }

  return {
    ok: true,
    key: {
      keyId: row.id,
      tenantId: row.tenant_id,
      integrationId: row.integration_id,
      roleSubset: parseRoleSubset(row.role_subset),
      keycloakClientId: integration.keycloak_client_id,
      clientSecret: {
        ciphertext: integration.client_secret_ciphertext,
        keyId: integration.client_secret_key_id,
        algorithm: integration.client_secret_algorithm,
      },
    },
  };
}

/**
 * Record that a key was used.
 *
 * `first_used_at` is set once (coalesce), which is what makes "minted but never
 * activated" findable; `last_used_at` moves every time, which is what makes a
 * key that has gone quiet retirable.
 *
 * Deliberately fire-and-forget at the call site: a telemetry write must never
 * fail an authenticated request, and the row is not read on the hot path.
 */
export async function recordApiKeyUse(
  db: OpenShapeForgeDatabase,
  keyId: string,
  now: Date = new Date(),
): Promise<void> {
  await sql`
    update platform.api_keys
       set first_used_at = coalesce(first_used_at, ${now}),
           last_used_at = ${now}
     where id = ${keyId}
  `.execute(db);
}
