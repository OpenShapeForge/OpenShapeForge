// SPDX-License-Identifier: BUSL-1.1
/**
 * Provisioning: what happens when a customer presses "add API key".
 *
 * Every mutation here starts by calling the ceiling (`ceiling.ts`). That is the
 * only authorization decision this module makes; tenant containment comes from
 * RLS on `platform.api_key_integrations`, which every read and write below goes
 * through.
 *
 * The cross-system ordering is the other thing worth reading carefully. Postgres
 * and Keycloak share no transaction, so a crash between them must not leave a
 * live credential pointing at a client that does not exist. The order is:
 *
 *   insert 'pending'  →  mutate the realm  →  mark 'active'
 *
 * A row stuck at 'pending' authenticates nothing (the store refuses any status
 * but 'active') and is exactly the record the reconciler needs to finish or
 * sweep the attempt. The reverse order would produce the dangerous state.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession } from "../../db/session.js";
import { encryptSecret, type SecretKeyring } from "../../platform/secrets.js";
import {
  assertMayGrantRoles,
  assertMayManageApiKeys,
  type CeilingSession,
} from "./ceiling.js";
import { invalidateIntegrationToken } from "./exchange.js";
import { mintApiKey } from "./format.js";
import { KeycloakAdmin } from "./keycloak-admin.js";

export type ProvisioningSession = CeilingSession & {
  tenantId: string;
  userId: string;
  groups?: readonly string[];
};

export type ApiKeyServiceDeps = {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  admin: KeycloakAdmin;
  /** The Keycloak client entity roles live on (`erp-provider` in the shipped realm). */
  entityRoleClientId: string;
};

export class ApiKeyProvisioningError extends Error {
  readonly code = "API_KEY_PROVISIONING_FAILED";
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyProvisioningError";
  }
}

export class ApiKeyNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyNotFoundError";
  }
}

/** Default key lifetime. A non-expiring key must be asked for explicitly. */
const DEFAULT_KEY_TTL_DAYS = 365;

function expiryFrom(days: number | null, now: Date): Date | null {
  if (days === null) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export type CreateIntegrationInput = {
  displayName: string;
  /** Roles to grant the integration's service account. Bounded by the ceiling. */
  roles: string[];
  /** null → never expires. Omitted → DEFAULT_KEY_TTL_DAYS. */
  expiresInDays?: number | null;
  /** Optional narrowing for the first key. null → the integration's full role set. */
  roleSubset?: string[] | null;
};

export type CreatedApiKey = {
  integrationId: string;
  keyId: string;
  /** The credential. Returned exactly once — it is not recoverable afterwards. */
  token: string;
  expiresAt: Date | null;
};

/**
 * Create an integration and its first key.
 *
 * The Keycloak clientId is derived, not chosen: `osf-int-<uuid>`. A
 * customer-supplied identifier would be an injection surface into the realm's
 * namespace, and would let one tenant squat on a name another expects.
 */
export async function createIntegration(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  input: CreateIntegrationInput,
  now: Date = new Date(),
): Promise<CreatedApiKey> {
  assertMayGrantRoles(session, input.roles);

  const displayName = input.displayName.trim();
  if (displayName === "") {
    throw new ApiKeyNotFoundError("An integration needs a display name.");
  }

  const integrationId = randomUUID();
  const keycloakClientId = `osf-int-${integrationId}`;

  // 1. Intent, recorded before anything external happens.
  await withSession(deps, session, async (trx) => {
    await sql`
      insert into platform.api_key_integrations
        (id, tenant_id, display_name, keycloak_client_id, status, granted_roles,
         created_by, created_at, updated_at)
      values
        (${integrationId}, ${session.tenantId}, ${displayName}, ${keycloakClientId},
         'pending', ${JSON.stringify(input.roles)}::jsonb, ${session.userId}, ${now}, ${now})
    `.execute(trx);
  });

  // 2. The realm. Anything that throws here leaves a 'pending' row behind, which
  //    is the intended failure mode rather than an accident.
  let provisioned;
  try {
    provisioned = await deps.admin.createServiceAccountClient(keycloakClientId, displayName);
    await deps.admin.setServiceAccountTenant(provisioned.serviceAccountUserId, session.tenantId);
    await deps.admin.grantClientRoles(
      provisioned.serviceAccountUserId,
      deps.entityRoleClientId,
      input.roles,
    );
  } catch (error) {
    throw new ApiKeyProvisioningError(
      `Could not provision the identity for "${displayName}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // 3. Commit the credential and flip the integration live, in ONE transaction:
  //    a key row that outlived a failed activation would be unusable but
  //    listed, and an active integration with no key would look provisioned
  //    while nothing had been handed to anyone.
  const minted = mintApiKey();
  const keyId = randomUUID();
  const expiresAt = expiryFrom(
    input.expiresInDays === undefined ? DEFAULT_KEY_TTL_DAYS : input.expiresInDays,
    now,
  );
  const encrypted = encryptSecret(
    deps.keyring,
    integrationId,
    "clientSecret",
    provisioned.clientSecret,
  );

  await withSession(deps, session, async (trx) => {
    await sql`
      update platform.api_key_integrations
         set status = 'active',
             client_secret_ciphertext = ${encrypted.ciphertext},
             client_secret_key_id = ${encrypted.keyId},
             client_secret_algorithm = ${encrypted.algorithm},
             updated_at = ${now}
       where id = ${integrationId}
    `.execute(trx);

    await insertKeyRow(trx, {
      keyId,
      tenantId: session.tenantId,
      integrationId,
      lookupId: minted.lookupId,
      secretHash: minted.secretHash,
      displayName,
      roleSubset: input.roleSubset ?? null,
      expiresAt,
      createdBy: session.userId,
      now,
    });
  });

  return { integrationId, keyId, token: minted.token, expiresAt };
}

export type IssueKeyInput = {
  integrationId: string;
  displayName: string;
  expiresInDays?: number | null;
  roleSubset?: string[] | null;
};

/**
 * Issue an additional key against an existing integration — the rotation
 * primitive. Two keys live at once, the old one is revoked after the external
 * party has cut over.
 *
 * The ceiling applies to the SUBSET, not just to creation: a subset is only
 * meaningful as a narrowing of roles the caller could have granted anyway, and
 * checking it here is what keeps `update`-shaped paths from being the weak one.
 */
export async function issueKey(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  input: IssueKeyInput,
  now: Date = new Date(),
): Promise<CreatedApiKey> {
  assertMayGrantRoles(session, input.roleSubset ?? []);

  const minted = mintApiKey();
  const keyId = randomUUID();
  const expiresAt = expiryFrom(
    input.expiresInDays === undefined ? DEFAULT_KEY_TTL_DAYS : input.expiresInDays,
    now,
  );

  await withSession(deps, session, async (trx) => {
    // RLS already confines this to the caller's tenant; the explicit predicate
    // is the same defense-in-depth the generated engine applies.
    const found = await sql<{ id: string }>`
      select id from platform.api_key_integrations
       where id = ${input.integrationId}
         and tenant_id = ${session.tenantId}
         and status = 'active'
       limit 1
    `.execute(trx);
    if (!found.rows[0]) {
      throw new ApiKeyNotFoundError("No such active integration.");
    }

    await insertKeyRow(trx, {
      keyId,
      tenantId: session.tenantId,
      integrationId: input.integrationId,
      lookupId: minted.lookupId,
      secretHash: minted.secretHash,
      displayName: input.displayName.trim(),
      roleSubset: input.roleSubset ?? null,
      expiresAt,
      createdBy: session.userId,
      now,
    });
  });

  return { integrationId: input.integrationId, keyId, token: minted.token, expiresAt };
}

export type ListedKey = {
  id: string;
  integrationId: string;
  integrationName: string;
  displayName: string;
  roleSubset: string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

/**
 * List the tenant's keys.
 *
 * The join through `api_key_integrations` is deliberate: that table carries the
 * tenant policy, so the join is what confines the result set even though
 * `api_keys` has no policy of its own.
 */
export async function listKeys(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
): Promise<ListedKey[]> {
  assertMayManageApiKeys(session);

  return withSession(deps, session, async (trx) => {
    const result = await sql<{
      id: string;
      integration_id: string;
      integration_name: string;
      display_name: string;
      role_subset: unknown;
      created_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
      last_used_at: Date | null;
    }>`
      select k.id, k.integration_id, i.display_name as integration_name,
             k.display_name, k.role_subset, k.created_at, k.expires_at,
             k.revoked_at, k.last_used_at
        from platform.api_keys k
        join platform.api_key_integrations i on i.id = k.integration_id
       where k.tenant_id = ${session.tenantId}
       order by k.created_at desc
    `.execute(trx);

    return result.rows.map((row) => ({
      id: row.id,
      integrationId: row.integration_id,
      integrationName: row.integration_name,
      displayName: row.display_name,
      roleSubset: Array.isArray(row.role_subset) ? (row.role_subset as string[]) : null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
    }));
  });
}

/**
 * Revoke a key. Idempotent, and never deletes: the row is the only evidence
 * that the credential existed and when it was last used.
 */
export async function revokeKey(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  keyId: string,
  now: Date = new Date(),
): Promise<void> {
  assertMayManageApiKeys(session);

  await withSession(deps, session, async (trx) => {
    const result = await sql<{ id: string }>`
      update platform.api_keys k
         set revoked_at = coalesce(k.revoked_at, ${now})
        from platform.api_key_integrations i
       where k.id = ${keyId}
         and i.id = k.integration_id
         and k.tenant_id = ${session.tenantId}
      returning k.id
    `.execute(trx);
    if (!result.rows[0]) {
      throw new ApiKeyNotFoundError("No such key.");
    }
  });
}

/**
 * Disable an integration and every key under it.
 *
 * Drops the cached token as well, so the change takes effect on the next
 * request rather than at the end of the current token's 15-minute life.
 */
export async function disableIntegration(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  integrationId: string,
  now: Date = new Date(),
): Promise<void> {
  assertMayManageApiKeys(session);

  await withSession(deps, session, async (trx) => {
    const result = await sql<{ id: string }>`
      update platform.api_key_integrations
         set status = 'disabled', updated_at = ${now}
       where id = ${integrationId}
         and tenant_id = ${session.tenantId}
      returning id
    `.execute(trx);
    if (!result.rows[0]) {
      throw new ApiKeyNotFoundError("No such integration.");
    }

    await sql`
      update platform.api_keys
         set revoked_at = coalesce(revoked_at, ${now})
       where integration_id = ${integrationId}
         and tenant_id = ${session.tenantId}
    `.execute(trx);
  });

  invalidateIntegrationToken(integrationId);
}

type InsertKeyArgs = {
  keyId: string;
  tenantId: string;
  integrationId: string;
  lookupId: string;
  secretHash: string;
  displayName: string;
  roleSubset: string[] | null;
  expiresAt: Date | null;
  createdBy: string;
  now: Date;
};

async function insertKeyRow(trx: unknown, args: InsertKeyArgs): Promise<void> {
  await sql`
    insert into platform.api_keys
      (id, tenant_id, integration_id, lookup_id, secret_hash, display_name,
       role_subset, expires_at, created_by, created_at)
    values
      (${args.keyId}, ${args.tenantId}, ${args.integrationId}, ${args.lookupId},
       ${args.secretHash}, ${args.displayName},
       ${args.roleSubset === null ? null : JSON.stringify(args.roleSubset)}::jsonb,
       ${args.expiresAt}, ${args.createdBy}, ${args.now})
  `.execute(trx as never);
}

/**
 * Every management statement runs inside the caller's own tenant session, so
 * the RLS policy on `api_key_integrations` is doing real work rather than being
 * bypassed by a service-level connection.
 */
function withSession<T>(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  callback: (trx: never) => Promise<T>,
): Promise<T> {
  return withDbSession(
    deps.db,
    {
      tenantId: session.tenantId,
      userId: session.userId,
      roles: [...session.roles],
      groups: session.groups ? [...session.groups] : [],
      scope: "tenant",
    },
    (trx) => callback(trx as never),
  );
}
