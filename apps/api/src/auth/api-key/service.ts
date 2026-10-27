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
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { withDbSession } from "../../db/session.js";
import { encryptSecret, type SecretKeyring } from "../../platform/secrets.js";
import {
  containsFilter,
  exactFilter,
  keysetPredicate,
  limitWithProbe,
  orderBy,
  takePage,
  type Page,
  type PageQuery,
  type SortColumn,
} from "./catalog-page.js";
import {
  assertMayGrantRoles,
  assertMayManageApiKeys,
  type CeilingSession,
} from "./ceiling.js";
import { invalidateIntegrationToken } from "./exchange.js";
import { mintApiKey } from "./format.js";
import { KeycloakAdmin } from "./keycloak-admin.js";
import { parseRoleSubset } from "./store.js";

export type ProvisioningSession = CeilingSession & {
  tenantId: string;
  userId: string;
  groups?: readonly string[];
};

export type { CeilingSession };

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

export class ApiKeyValidationError extends Error {
  readonly code = "VALIDATION";
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyValidationError";
  }
}

/**
 * A subset is a narrowing or it is absent. An EMPTY subset is neither: the
 * store reads `[]` back as "no narrowing recorded" (store.ts, parseRoleSubset),
 * so accepting it here would mint an unrestricted key from a request that
 * looked like the most restricted one possible. Refused instead.
 */
function roleSubsetOrThrow(subset: string[] | null | undefined): string[] | null {
  if (subset === undefined || subset === null) return null;
  const roles = [...new Set(subset.map((role) => role.trim()).filter(Boolean))];
  if (roles.length === 0) {
    throw new ApiKeyValidationError(
      "roleSubset must name at least one role, or be omitted for the integration's full role set.",
    );
  }
  return roles;
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
  assertMayManageApiKeys(session);
  const roleSubset = roleSubsetOrThrow(input.roleSubset);
  assertMayGrantRoles(session, [...input.roles, ...(roleSubset ?? [])]);

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
         'pending', ${jsonbLiteral(input.roles)}, ${session.userId}, ${now}, ${now})
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
      roleSubset,
      expiresAt,
      createdBy: session.userId,
      now,
    });
  });

  return { integrationId, keyId, token: minted.token, expiresAt };
}

/**
 * Take the integration's row lock, tenant-fenced, before deciding anything
 * about the keys under it.
 *
 * This is the serialization point `issueKey` and `disableIntegration` SHARE,
 * and sharing it is the whole point. Without it the two interleave into a
 * credential nobody asked for: disable reads the integration, revokes the keys
 * it can see and commits, while a concurrent issue — which read the same
 * integration as 'active' before that commit — inserts a key afterwards. The
 * result is a live credential under a disabled parent, which the exchange path
 * then has to be trusted to notice. With both statements taking this lock
 * first, in this order (integration, then its keys), one of the two waits and
 * then sees the other's committed status: a disable that lands first makes the
 * issue a NOT_FOUND, and an issue that lands first has its key revoked by the
 * disable.
 *
 * `for update` is on the integration row only. RLS already confines the row to
 * the caller's tenant; the explicit `tenant_id` predicate is the same
 * defense-in-depth the generated engine applies, and it keeps the lock from
 * ever being taken on another tenant's row even if a policy were relaxed.
 */
async function lockIntegration(
  trx: unknown,
  tenantId: string,
  integrationId: string,
): Promise<{ id: string; status: string; granted_roles: unknown } | undefined> {
  const found = await sql<{ id: string; status: string; granted_roles: unknown }>`
    select id, status, granted_roles
      from platform.api_key_integrations
     where id = ${integrationId}
       and tenant_id = ${tenantId}
     limit 1
     for update
  `.execute(trx as never);
  return found.rows[0];
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
 * The ceiling applies to what the KEY WILL HOLD, not just to creation: with a
 * subset that is the subset, without one it is the integration's full granted
 * set — a caller who has since lost a role the integration holds may not mint
 * a fresh key carrying it. Checking it here is what keeps `update`-shaped
 * paths from being the weak one.
 */
export async function issueKey(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  input: IssueKeyInput,
  now: Date = new Date(),
): Promise<CreatedApiKey> {
  assertMayManageApiKeys(session);
  const roleSubset = roleSubsetOrThrow(input.roleSubset);

  const minted = mintApiKey();
  const keyId = randomUUID();
  const expiresAt = expiryFrom(
    input.expiresInDays === undefined ? DEFAULT_KEY_TTL_DAYS : input.expiresInDays,
    now,
  );

  await withSession(deps, session, async (trx) => {
    const parent = await lockIntegration(trx, session.tenantId, input.integrationId);
    if (!parent || parent.status !== "active") {
      throw new ApiKeyNotFoundError("No such active integration.");
    }
    assertMayGrantRoles(session, roleSubset ?? (parseRoleSubset(parent.granted_roles) ?? []));

    await insertKeyRow(trx, {
      keyId,
      tenantId: session.tenantId,
      integrationId: input.integrationId,
      lookupId: minted.lookupId,
      secretHash: minted.secretHash,
      displayName: input.displayName.trim(),
      roleSubset,
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

type KeyRow = {
  id: string;
  integration_id: string;
  integration_name: string;
  display_name: string;
  role_subset: unknown;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
};

/** The columns a management read may select. No secret_hash, no lookup_id. */
const KEY_METADATA_COLUMNS = sql`
  k.id, k.integration_id, i.display_name as integration_name,
  k.display_name, k.role_subset, k.created_at, k.expires_at,
  k.revoked_at, k.last_used_at
`;

/**
 * A credential's lifecycle status, as ONE expression.
 *
 * It is derived rather than stored, so it has to be derived in the database:
 * deriving it afterwards would mean filtering and sorting a page that was
 * already cut, which is how an "active only" list ends up a page short. `now`
 * is bound once per request, so the sort, the filter and the keyset all agree
 * about where the expiry boundary is even if the request spans it.
 */
function credentialStatusExpr(now: Date) {
  return sql`case
    when k.revoked_at is not null then 'revoked'
    when k.expires_at is not null and k.expires_at <= ${now} then 'expired'
    else 'active'
  end`;
}

export type CredentialSortField =
  | "displayName" | "status" | "createdAt" | "expiresAt" | "lastUsedAt";

function credentialSort(field: CredentialSortField, now: Date): SortColumn {
  switch (field) {
    case "status": return { expr: credentialStatusExpr(now) };
    case "createdAt": return { expr: sql`k.created_at`, cast: "timestamptz" };
    case "expiresAt": return { expr: sql`k.expires_at`, cast: "timestamptz" };
    case "lastUsedAt": return { expr: sql`k.last_used_at`, cast: "timestamptz" };
    // Case-insensitive, and the same expression the cursor value is rendered
    // from, so paging by name is not sensitive to the display casing.
    default: return { expr: sql`lower(k.display_name)` };
  }
}

function listedKey(row: KeyRow): ListedKey {
  return {
    id: row.id,
    integrationId: row.integration_id,
    integrationName: row.integration_name,
    displayName: row.display_name,
    roleSubset: parseRoleSubset(row.role_subset),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * List the tenant's keys, or those of one integration.
 *
 * The join through `api_key_integrations` is deliberate: that table carries the
 * tenant policy, so the join is what confines the result set even though
 * `api_keys` has no policy of its own.
 *
 * `integrationId` is a SUBJECT BINDING, not a filter the caller may widen: it
 * is matched alongside the tenant predicate, so naming another tenant's
 * integration yields an empty page rather than its keys.
 *
 * Unpaged, and kept that way: the existing REST and GraphQL surfaces return
 * the whole set and changing that would break their published contracts. The
 * canonical catalog Operations use {@link pageKeys} instead.
 */
export async function listKeys(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  scope: { integrationId?: string } = {},
): Promise<ListedKey[]> {
  assertMayManageApiKeys(session);

  return withSession(deps, session, async (trx) => {
    const result = await sql<KeyRow>`
      select ${KEY_METADATA_COLUMNS}
        from platform.api_keys k
        join platform.api_key_integrations i on i.id = k.integration_id
       where k.tenant_id = ${session.tenantId}
         ${scope.integrationId === undefined
           ? sql``
           : sql`and k.integration_id = ${scope.integrationId}`}
       order by k.created_at desc
    `.execute(trx);

    return result.rows.map(listedKey);
  });
}

/** How many rows one page may carry, whatever a caller asks for. */
export const MAX_PAGE_SIZE = 100;

function boundedFirst(first: number): number {
  if (!Number.isFinite(first)) return 1;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(first)));
}

export type ListedKeyPage = Page<ListedKey & { cursorValue: string | null }>;

/**
 * One keyset page of the credentials under ONE integration.
 *
 * The integration is required rather than optional: a credential page is
 * always read in the context of its parent, and requiring it keeps the cursor
 * from ever addressing a row outside the subject it was issued for. Both the
 * tenant and the integration are predicates on every statement here, so
 * neither a forged cursor nor a tampered sort can widen the set — the worst a
 * tampered cursor can do is move the resume point inside a set the caller was
 * already entitled to read.
 */
export async function pageKeys(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  scope: { integrationId: string },
  query: PageQuery<CredentialSortField>,
  now: Date = new Date(),
): Promise<ListedKeyPage> {
  assertMayManageApiKeys(session);

  const first = boundedFirst(query.first);
  const column = credentialSort(query.sortField, now);
  const status = credentialStatusExpr(now);

  return withSession(deps, session, async (trx) => {
    // The fence, repeated verbatim in both statements below. Written once as a
    // fragment so the count can never drift from the page it describes.
    const fence = sql`
      k.tenant_id = ${session.tenantId}
        and k.integration_id = ${scope.integrationId}
        ${containsFilter(sql`k.display_name`, query.displayName)}
        ${exactFilter(status, query.status)}
    `;

    const counted = await sql<{ total: string | number }>`
      select count(*) as total
        from platform.api_keys k
       where ${fence}
    `.execute(trx);

    const result = await sql<KeyRow & { sort_value: string | null }>`
      select ${KEY_METADATA_COLUMNS}, (${column.expr})::text as sort_value
        from platform.api_keys k
        join platform.api_key_integrations i on i.id = k.integration_id
       where ${fence}
         ${keysetPredicate(column, sql`k.id`, { ...query, ...(query.after ? { after: query.after } : {}) })}
       ${orderBy(column, sql`k.id`, query.sortDirection)}
       ${limitWithProbe(first)}
    `.execute(trx);

    const page = takePage(result.rows, first, Number(counted.rows[0]?.total ?? 0));
    return {
      ...page,
      rows: page.rows.map((row) => ({ ...listedKey(row), cursorValue: row.sort_value })),
    };
  });
}

/**
 * One key by id, bound to the integration it was issued under.
 *
 * Both identifiers are predicates: a key id that exists but belongs to another
 * integration is reported as absent, so the nested read cannot be used to walk
 * out of the integration it was opened on.
 */
export async function getKey(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  target: { keyId: string; integrationId: string },
): Promise<ListedKey> {
  assertMayManageApiKeys(session);

  return withSession(deps, session, async (trx) => {
    const result = await sql<KeyRow>`
      select ${KEY_METADATA_COLUMNS}
        from platform.api_keys k
        join platform.api_key_integrations i on i.id = k.integration_id
       where k.tenant_id = ${session.tenantId}
         and k.id = ${target.keyId}
         and k.integration_id = ${target.integrationId}
       limit 1
    `.execute(trx);

    const row = result.rows[0];
    if (!row) throw new ApiKeyNotFoundError("No such key.");
    return listedKey(row);
  });
}

export type ListedIntegration = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "disabled";
  /** Roles the service account holds, as the provisioning caller authorized them. */
  grantedRoles: string[];
  createdAt: Date;
  updatedAt: Date;
  keyCount: number;
  /** Keys that are neither revoked nor past their expiry. */
  activeKeyCount: number;
};

type IntegrationRow = {
  id: string;
  display_name: string;
  status: string;
  granted_roles: unknown;
  created_at: Date;
  updated_at: Date;
  key_count: string | number;
  active_key_count: string | number;
};

/**
 * The integration columns a management read may select.
 *
 * The encrypted client secret is deliberately absent, and so is
 * `keycloak_client_id`: it is derived (`osf-int-<id>`) and is realm internals,
 * while `id` is the stable identifier the realm reconciler rebuilds a missing
 * client UNDER rather than replaces.
 */
function integrationMetadataColumns(now: Date) {
  return sql`
    i.id, i.display_name, i.status, i.granted_roles, i.created_at, i.updated_at,
    count(k.id) as key_count,
    count(k.id) filter (
      where k.revoked_at is null and (k.expires_at is null or k.expires_at > ${now})
    ) as active_key_count
  `;
}

export type IntegrationSortField = "displayName" | "status" | "createdAt" | "updatedAt";

function integrationSort(field: IntegrationSortField): SortColumn {
  switch (field) {
    case "status": return { expr: sql`i.status` };
    case "createdAt": return { expr: sql`i.created_at`, cast: "timestamptz" };
    case "updatedAt": return { expr: sql`i.updated_at`, cast: "timestamptz" };
    default: return { expr: sql`lower(i.display_name)` };
  }
}

function listedIntegration(row: IntegrationRow): ListedIntegration {
  const status = row.status === "active" || row.status === "disabled" ? row.status : "pending";
  return {
    id: row.id,
    displayName: row.display_name,
    status,
    // An absent or malformed array is no roles, never "every role".
    grantedRoles: Array.isArray(row.granted_roles)
      ? row.granted_roles.filter((role): role is string => typeof role === "string")
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Postgres counts arrive as bigint, which the driver hands back as text.
    keyCount: Number(row.key_count),
    activeKeyCount: Number(row.active_key_count),
  };
}

export type ListedIntegrationPage = Page<ListedIntegration & { cursorValue: string | null }>;

/**
 * One keyset page of the caller's integrations, with each one's key counts.
 *
 * The counts come from a LEFT JOIN that is aggregated AFTER the fence and the
 * keyset have selected the page's integrations, so an account with many keys
 * pays for the page's keys and not for the tenant's. `totalCount` is a
 * separate count over `api_key_integrations` alone — counting the joined rows
 * would report keys, not integrations.
 */
export async function pageIntegrations(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  query: PageQuery<IntegrationSortField>,
  now: Date = new Date(),
): Promise<ListedIntegrationPage> {
  assertMayManageApiKeys(session);

  const first = boundedFirst(query.first);
  const column = integrationSort(query.sortField);

  return withSession(deps, session, async (trx) => {
    const fence = sql`
      i.tenant_id = ${session.tenantId}
        ${containsFilter(sql`i.display_name`, query.displayName)}
        ${exactFilter(sql`i.status`, query.status)}
    `;

    const counted = await sql<{ total: string | number }>`
      select count(*) as total
        from platform.api_key_integrations i
       where ${fence}
    `.execute(trx);

    const result = await sql<IntegrationRow & { sort_value: string | null }>`
      select ${integrationMetadataColumns(now)}, (${column.expr})::text as sort_value
        from platform.api_key_integrations i
        left join platform.api_keys k
          on k.integration_id = i.id and k.tenant_id = i.tenant_id
       where ${fence}
         ${keysetPredicate(column, sql`i.id`, { ...query, ...(query.after ? { after: query.after } : {}) })}
       group by i.id
       ${orderBy(column, sql`i.id`, query.sortDirection)}
       ${limitWithProbe(first)}
    `.execute(trx);

    const page = takePage(result.rows, first, Number(counted.rows[0]?.total ?? 0));
    return {
      ...page,
      rows: page.rows.map((row) => ({ ...listedIntegration(row), cursorValue: row.sort_value })),
    };
  });
}

/** One integration by its stable id. Absent in this tenant reads as absent. */
export async function getIntegration(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  integrationId: string,
  now: Date = new Date(),
): Promise<ListedIntegration> {
  assertMayManageApiKeys(session);

  return withSession(deps, session, async (trx) => {
    const result = await sql<IntegrationRow>`
      select ${integrationMetadataColumns(now)}
        from platform.api_key_integrations i
        left join platform.api_keys k
          on k.integration_id = i.id and k.tenant_id = i.tenant_id
       where i.tenant_id = ${session.tenantId}
         and i.id = ${integrationId}
       group by i.id
       limit 1
    `.execute(trx);

    const row = result.rows[0];
    if (!row) throw new ApiKeyNotFoundError("No such integration.");
    return listedIntegration(row);
  });
}

/**
 * Revoke a key. Idempotent, and never deletes: the row is the only evidence
 * that the credential existed and when it was last used.
 *
 * Returns the revocation instant as it now stands — the earlier one when the
 * key was already revoked, which is what makes a repeated call honest rather
 * than silently rewriting history.
 */
export async function revokeKey(
  deps: ApiKeyServiceDeps,
  session: ProvisioningSession,
  keyId: string,
  now: Date = new Date(),
): Promise<{ id: string; revokedAt: Date }> {
  assertMayManageApiKeys(session);

  return withSession(deps, session, async (trx) => {
    const result = await sql<{ id: string; revoked_at: Date }>`
      update platform.api_keys k
         set revoked_at = coalesce(k.revoked_at, ${now})
        from platform.api_key_integrations i
       where k.id = ${keyId}
         and i.id = k.integration_id
         and k.tenant_id = ${session.tenantId}
      returning k.id, k.revoked_at
    `.execute(trx);
    const row = result.rows[0];
    if (!row) {
      throw new ApiKeyNotFoundError("No such key.");
    }
    return { id: row.id, revokedAt: row.revoked_at };
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
): Promise<{ id: string; revokedKeys: number }> {
  assertMayManageApiKeys(session);

  const revokedKeys = await withSession(deps, session, async (trx) => {
    // The same lock `issueKey` takes, in the same order, so a concurrent issue
    // either waits and then finds this integration disabled, or commits first
    // and has its key revoked below. See `lockIntegration`.
    if (!await lockIntegration(trx, session.tenantId, integrationId)) {
      throw new ApiKeyNotFoundError("No such integration.");
    }
    await sql`
      update platform.api_key_integrations
         set status = 'disabled', updated_at = ${now}
       where id = ${integrationId}
         and tenant_id = ${session.tenantId}
    `.execute(trx);

    // Only rows that were not already revoked are stamped and counted — an
    // expired key included, because expiry is not revocation. The predicate is
    // what makes a second disable report 0 instead of the whole history again.
    const revoked = await sql<{ id: string }>`
      update platform.api_keys
         set revoked_at = ${now}
       where integration_id = ${integrationId}
         and tenant_id = ${session.tenantId}
         and revoked_at is null
      returning id
    `.execute(trx);
    return revoked.rows.length;
  });

  invalidateIntegrationToken(integrationId);
  return { id: integrationId, revokedKeys };
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
       ${jsonbLiteral(args.roleSubset)},
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
