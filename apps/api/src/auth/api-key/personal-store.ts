// SPDX-License-Identifier: BUSL-1.1
/**
 * Reading a presented personal key back to the person who owns it.
 *
 * The same two-step shape as the integration store (store.ts), for the same
 * reasons: `app.personal_api_key_tenant(lookup_id)` answers the ONE tenant a
 * lookup id belongs to — the only statement that runs without a tenant — and
 * everything after it runs in an ordinary tenant-fenced session, where the
 * secret is compared, never queried. An unknown lookup id costs the same as a
 * known one, so response time does not tell a caller which ids exist.
 *
 * Nothing here decides what the owner may do. It decides whether the key is
 * real, live and whose; personal-resolve.ts then asks the realm and the
 * membership row what that person may do right now.
 */
import { storedList } from "./restrictions.js";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withCredentialResolutionSession } from "../../db/session.js";
import { secretMatches } from "./format.js";
import { parseRoleSubset } from "./store.js";

/**
 * A key nobody used for this long stops working, whatever its expiry says.
 * The same rule Databricks applies to personal tokens: a forgotten credential
 * is the one nobody notices leaking. The owner mints a new one.
 */
export const PERSONAL_KEY_DORMANT_AFTER_DAYS = 90;

export type ResolvedPersonalKey = {
  keyId: string;
  tenantId: string;
  ownerIssuer: string;
  ownerUserId: string;
  displayName: string;
  /** null means "whatever the owner holds when the key is used". */
  roleSubset: string[] | null;
  /** The key's network allowlist; empty means any address. */
  allowedIps: string[];
};

export type PersonalKeyRejection =
  | "unknown"
  | "bad-secret"
  | "revoked"
  | "expired"
  | "dormant";

export type PersonalKeyLookupResult =
  | { ok: true; key: ResolvedPersonalKey }
  | { ok: false; reason: PersonalKeyRejection };

type KeyRow = {
  id: string;
  tenant_id: string;
  owner_issuer: string;
  owner_user_id: string;
  display_name: string;
  secret_hash: string;
  role_subset: unknown;
  allowed_ips: unknown;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
  last_used_at: Date | string | null;
};

const DECOY_TENANT_ID = "00000000-0000-4000-8000-000000000000";
const DECOY_SECRET_HASH = "0".repeat(64);
const DAY_MS = 86_400_000;

function asDate(value: Date | string): Date;
function asDate(value: Date | string | null): Date | null;
function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function resolvePersonalApiKey(
  db: OpenShapeForgeDatabase,
  lookupId: string,
  secret: string,
  now: Date = new Date(),
): Promise<PersonalKeyLookupResult> {
  const tenantResult = await sql<{ tenant_id: string | null }>`
    select app.personal_api_key_tenant(${lookupId}) as tenant_id
  `.execute(db);
  const tenantId = tenantResult.rows[0]?.tenant_id ?? DECOY_TENANT_ID;
  const row = await withCredentialResolutionSession(db, tenantId, async (trx) => {
    const result = await sql<KeyRow>`
      select id, tenant_id, owner_issuer, owner_user_id, display_name, secret_hash,
             role_subset, allowed_ips, expires_at, revoked_at, created_at, last_used_at
        from platform.personal_api_keys
       where lookup_id = ${lookupId}
       limit 1
    `.execute(trx);
    return result.rows[0];
  });
  if (!row) {
    secretMatches(secret, DECOY_SECRET_HASH);
    return { ok: false, reason: "unknown" };
  }
  if (!secretMatches(secret, row.secret_hash)) return { ok: false, reason: "bad-secret" };
  if (asDate(row.revoked_at) !== null) return { ok: false, reason: "revoked" };
  if (asDate(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  const lastActivity = asDate(row.last_used_at) ?? asDate(row.created_at);
  if (now.getTime() - lastActivity.getTime() > PERSONAL_KEY_DORMANT_AFTER_DAYS * DAY_MS) {
    return { ok: false, reason: "dormant" };
  }
  return {
    ok: true,
    key: {
      keyId: row.id,
      tenantId: row.tenant_id,
      ownerIssuer: row.owner_issuer,
      ownerUserId: row.owner_user_id,
      displayName: row.display_name,
      roleSubset: parseRoleSubset(row.role_subset),
      allowedIps: storedList(row.allowed_ips),
    },
  };
}

/**
 * Record that a personal key was used. Telemetry and the dormancy clock, never
 * a gate: fire-and-forget at the call site, and `skip locked` so it never
 * waits behind a revoke that holds the row.
 */
export async function recordPersonalApiKeyUse(
  db: OpenShapeForgeDatabase,
  key: { keyId: string; tenantId: string },
  now: Date = new Date(),
): Promise<void> {
  await withCredentialResolutionSession(db, key.tenantId, async (trx) => {
    await sql`
      update platform.personal_api_keys
         set first_used_at = coalesce(first_used_at, ${now}),
             last_used_at = ${now}
       where id = (
         select k.id from platform.personal_api_keys k
          where k.id = ${key.keyId}
          for no key update skip locked
       )
    `.execute(trx);
  });
}
