// SPDX-License-Identifier: BUSL-1.1
/**
 * Personal API keys: credentials a person mints for themselves.
 *
 * The integration service beside this one (service.ts) gives an EXTERNAL
 * PARTY a service account of its own; the organization owns it and an
 * administrator manages it. A personal key is the other kind: it belongs to
 * the person who minted it, it acts as that person with whatever they may do
 * at the time of each request (personal-resolve.ts), and it dies with their
 * access. So:
 *
 *   - the owner mints, lists and revokes their OWN keys
 *     (`Platform.ApiKeys.Personal`);
 *   - an administrator may see every person's keys — metadata, never the
 *     secret (`Platform.ApiKeys.PersonalRead`) — and revoke any of them
 *     (`Platform.ApiKeys.PersonalRevoke`), which the owner then sees as
 *     revoked by an administrator and the audit trail records;
 *   - nobody mints a key for somebody else. There is no such function.
 *
 * Every function starts with the ceiling (ceiling.ts), whose carrier rule
 * keeps every API key — personal or not — off this surface. Every statement
 * carries an explicit owner or administrator predicate, and RLS on the table
 * (db/migrations/api-keys.ts) carries the same one, so a missed predicate
 * fails closed rather than open.
 *
 * No realm is touched. A personal key needs no Keycloak client: the person
 * already has an identity, and the key only names it.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { activeDbSessionContext, withDbSession, type DbSessionInput } from "../../db/session.js";
import { appendScopedEntityEventInTransaction } from "../../platform/entity-events.js";
import {
  containsFilter,
  exactFilter,
  MOVED_ANCHOR,
  pageStatement,
  takePage,
  UNUSABLE_CURSOR,
  type Page,
  type PageAnchor,
  type PageQuery,
  type PageStatementRow,
  type SortColumn,
} from "./catalog-page.js";
import {
  assertMayCreatePersonalKey,
  assertMayHoldPersonalKeys,
  assertMayReadPersonalKeys,
  assertMayRevokePersonalKeys,
  type CeilingSession,
} from "./ceiling.js";
import { mintPersonalApiKey } from "./format.js";
import { ApiKeyNotFoundError, ApiKeyValidationError, MAX_PAGE_SIZE } from "./service.js";
import { parseRoleSubset } from "./store.js";
import { ApiKeyRestrictionInputError, normalizeAllowedIps, storedList } from "./restrictions.js";

/**
 * A personal key's lifetime, in days. Shorter than an integration's on
 * purpose: a person's key lives in a script or a tool on their own machine,
 * and is cheap to mint again. Always finite — there is no "never".
 */
export const PERSONAL_KEY_DEFAULT_TTL_DAYS = 30;
export const PERSONAL_KEY_MAX_TTL_DAYS = 90;

/** The audit trail's name for a personal key, in `platform.entity_events`. */
export const PERSONAL_API_KEY_AGGREGATE = "PersonalApiKey";

export type PersonalKeySession = CeilingSession & {
  tenantId: string;
  userId: string;
  /** The identity's issuer: with `userId` it names the owner. */
  issuer?: string | undefined;
  groups?: readonly string[];
};

export type PersonalKeyServiceDeps = { db: OpenShapeForgeDatabase };

export type CreatePersonalKeyInput = {
  displayName: string;
  /** Narrowing. Omitted or null: whatever the owner holds at each request. */
  roleSubset?: string[] | null;
  /** Omitted: {@link PERSONAL_KEY_DEFAULT_TTL_DAYS}. */
  expiresInDays?: number;
  /** Optional network allowlist (IP addresses and CIDR ranges); restrictions.ts. */
  allowedIps?: string[] | null;
};

export type CreatedPersonalKey = {
  key: ListedPersonalKey;
  /** The credential. Returned exactly once; the stored half is a hash. */
  token: string;
};

export type PersonalKeyStatus = "active" | "expired" | "revoked";

export type ListedPersonalKey = {
  id: string;
  displayName: string;
  ownerUserId: string;
  /** The owner's name as the organization knows it; null when unknown. */
  ownerName: string | null;
  roleSubset: string[] | null;
  /** Network allowlist; empty means any address. */
  allowedIps: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /** True when somebody other than the owner revoked it. */
  revokedByAdministrator: boolean;
  lastUsedAt: Date | null;
};

const DAY_MS = 86_400_000;

function expiryFrom(requested: number | undefined, now: Date): Date {
  const days = requested ?? PERSONAL_KEY_DEFAULT_TTL_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > PERSONAL_KEY_MAX_TTL_DAYS) {
    throw new ApiKeyValidationError(
      `A personal API key lives from 1 through ${PERSONAL_KEY_MAX_TTL_DAYS} days.`,
    );
  }
  return new Date(now.getTime() + days * DAY_MS);
}

function subsetOrThrow(subset: string[] | null | undefined): string[] | null {
  if (subset === undefined || subset === null) return null;
  const roles = [...new Set(subset.map((role) => role.trim()).filter(Boolean))].sort();
  if (roles.length === 0) {
    throw new ApiKeyValidationError(
      "roleSubset must name at least one role, or be omitted for everything you hold.",
    );
  }
  return roles;
}

function ownerIssuer(session: PersonalKeySession): string {
  const issuer = session.issuer?.trim();
  // The key names an identity (issuer, subject). A session that cannot name
  // its issuer cannot name the identity, and a key bound to half of one would
  // be somebody else's under another realm.
  if (!issuer) {
    throw new ApiKeyValidationError("This session names no identity issuer, so no personal key can be bound to it.");
  }
  return issuer;
}

/** Mint a personal key for the caller. The secret is returned once. */
export async function createPersonalKey(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  input: CreatePersonalKeyInput,
  now: Date = new Date(),
): Promise<CreatedPersonalKey> {
  const roleSubset = subsetOrThrow(input.roleSubset);
  assertMayCreatePersonalKey(session, roleSubset ?? []);
  const displayName = input.displayName.trim();
  if (displayName === "") throw new ApiKeyValidationError("A personal API key needs a name.");
  let allowedIps: string[];
  try { allowedIps = normalizeAllowedIps(input.allowedIps); }
  catch (error) {
    if (error instanceof ApiKeyRestrictionInputError) throw new ApiKeyValidationError(error.message);
    throw error;
  }
  const issuer = ownerIssuer(session);
  const expiresAt = expiryFrom(input.expiresInDays, now);
  const minted = mintPersonalApiKey();
  const id = randomUUID();

  await withSession(deps, session, async (trx) => {
    await sql`
      insert into platform.personal_api_keys
        (id, tenant_id, owner_issuer, owner_user_id, lookup_id, secret_hash,
         display_name, role_subset, allowed_ips, expires_at, created_at)
      values
        (${id}, ${session.tenantId}, ${issuer}, ${session.userId}, ${minted.lookupId},
         ${minted.secretHash}, ${displayName}, ${jsonbLiteral(roleSubset)},
         ${allowedIps.length === 0 ? null : jsonbLiteral(allowedIps)}, ${expiresAt}, ${now})
    `.execute(trx);
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: PERSONAL_API_KEY_AGGREGATE,
      aggregateId: id,
      eventType: "personal_api_key_created",
      payload: { ownerUserId: session.userId, roleSubset, allowedIps, expiresAt: expiresAt.toISOString(), actorUserId: session.userId },
    });
  });

  return {
    token: minted.token,
    key: {
      id,
      displayName,
      ownerUserId: session.userId,
      ownerName: null,
      roleSubset,
      allowedIps,
      createdAt: now,
      expiresAt,
      revokedAt: null,
      revokedByAdministrator: false,
      lastUsedAt: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Reads

type KeyRow = {
  id: string;
  display_name: string;
  owner_user_id: string;
  owner_name: string | null;
  role_subset: unknown;
  allowed_ips: unknown;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  last_used_at: Date | null;
};

/** Metadata only: never `secret_hash`, never `lookup_id`. */
const METADATA_COLUMNS = sql`
  k.id, k.display_name, k.owner_user_id,
  coalesce(i.display_name, i.email) as owner_name,
  k.role_subset, k.allowed_ips, k.created_at, k.expires_at, k.revoked_at, k.revoked_by, k.last_used_at
`;

/** The owner's identity row, for a name an administrator recognises. */
const PAGE_FROM = sql`
  platform.personal_api_keys k
  left join platform.identities i
    on i.issuer = k.owner_issuer and i.subject = k.owner_user_id::text`;

function listed(row: KeyRow): ListedPersonalKey {
  return {
    id: row.id,
    displayName: row.display_name,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    roleSubset: parseRoleSubset(row.role_subset),
    allowedIps: storedList(row.allowed_ips),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByAdministrator: row.revoked_by !== null && row.revoked_by !== row.owner_user_id,
    lastUsedAt: row.last_used_at,
  };
}

function statusExpr(now: Date) {
  return sql`case
    when k.revoked_at is not null then 'revoked'
    when k.expires_at <= ${now} then 'expired'
    else 'active'
  end`;
}

export function personalKeyStatus(key: Pick<ListedPersonalKey, "revokedAt" | "expiresAt">, now: Date): PersonalKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export type PersonalKeySortField = "displayName" | "status" | "createdAt" | "expiresAt" | "lastUsedAt";

function sortColumn(field: PersonalKeySortField, now: Date): SortColumn {
  switch (field) {
    case "status": return { expr: statusExpr(now) };
    case "createdAt": return { expr: sql`k.created_at`, cast: "timestamptz" };
    case "expiresAt": return { expr: sql`k.expires_at`, cast: "timestamptz" };
    case "lastUsedAt": return { expr: sql`k.last_used_at`, cast: "timestamptz" };
    default: return { expr: sql`lower(k.display_name)` };
  }
}

function assertAnchorStood(row: PageStatementRow | undefined, anchor: PageAnchor | undefined): void {
  if (!anchor) return;
  if (!row?.anchor_found) throw new ApiKeyValidationError(UNUSABLE_CURSOR);
  if (row.anchor_digest !== anchor.value) throw new ApiKeyValidationError(MOVED_ANCHOR);
}

async function pageWithin(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  subject: ReturnType<typeof sql>,
  query: PageQuery<PersonalKeySortField>,
  now: Date,
): Promise<Page<ListedPersonalKey>> {
  const first = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(query.first) || 1));
  const column = sortColumn(query.sortField, now);
  return withSession(deps, session, async (trx) => {
    const fence = sql`
      k.tenant_id = ${session.tenantId}
        and ${subject}
        ${containsFilter(sql`k.display_name`, query.displayName)}
        ${exactFilter(statusExpr(now), query.status)}
    `;
    const result = await sql<KeyRow & { sort_digest: string } & PageStatementRow>`
      ${pageStatement({
        column,
        id: sql`k.id`,
        direction: query.sortDirection,
        first,
        from: sql`platform.personal_api_keys k`,
        pageFrom: PAGE_FROM,
        fence,
        columns: METADATA_COLUMNS,
        ...(query.after
          ? { anchor: { cursor: query.after, fence: sql`k.tenant_id = ${session.tenantId} and ${subject} and k.id = ${query.after.id}` } }
          : {}),
      })}
    `.execute(trx);
    assertAnchorStood(result.rows[0], query.after);
    const page = takePage(result.rows, first);
    return { ...page, rows: page.rows.map(listed) };
  });
}

/** One page of the CALLER's own keys. */
export async function pageMyPersonalKeys(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  query: PageQuery<PersonalKeySortField>,
  now: Date = new Date(),
): Promise<Page<ListedPersonalKey>> {
  assertMayHoldPersonalKeys(session);
  return pageWithin(deps, session, sql`k.owner_user_id = ${session.userId}`, query, now);
}

/** One page of EVERY person's keys in the organization; optionally one owner's. */
export async function pageOrganizationPersonalKeys(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  query: PageQuery<PersonalKeySortField> & { ownerUserId?: string },
  now: Date = new Date(),
): Promise<Page<ListedPersonalKey>> {
  assertMayReadPersonalKeys(session);
  const subject = query.ownerUserId === undefined ? sql`true` : sql`k.owner_user_id = ${query.ownerUserId}`;
  return pageWithin(deps, session, subject, query, now);
}

async function readOne(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  subject: ReturnType<typeof sql>,
  keyId: string,
): Promise<ListedPersonalKey> {
  return withSession(deps, session, async (trx) => {
    const result = await sql<KeyRow>`
      select ${METADATA_COLUMNS} from ${PAGE_FROM}
       where k.tenant_id = ${session.tenantId} and ${subject} and k.id = ${keyId}
       limit 1
    `.execute(trx);
    const row = result.rows[0];
    if (!row) throw new ApiKeyNotFoundError("No such personal API key.");
    return listed(row);
  });
}

/** One of the caller's own keys. Another person's key is "not found". */
export async function getMyPersonalKey(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  keyId: string,
): Promise<ListedPersonalKey> {
  assertMayHoldPersonalKeys(session);
  return readOne(deps, session, sql`k.owner_user_id = ${session.userId}`, keyId);
}

/** Any person's key, for an administrator. */
export async function getOrganizationPersonalKey(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  keyId: string,
): Promise<ListedPersonalKey> {
  assertMayReadPersonalKeys(session);
  return readOne(deps, session, sql`true`, keyId);
}

// ---------------------------------------------------------------------------
// Revocation

async function revoke(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  subject: ReturnType<typeof sql>,
  keyId: string,
  eventType: "personal_api_key_revoked" | "personal_api_key_revoked_by_administrator",
  now: Date,
): Promise<ListedPersonalKey> {
  return withSession(deps, session, async (trx) => {
    // Idempotent: a second revoke keeps the first instant and the first actor,
    // so repeating it never rewrites who withdrew the key or when.
    const result = await sql<{ id: string; owner_user_id: string; newly: boolean }>`
      update platform.personal_api_keys k
         set revoked_at = coalesce(k.revoked_at, ${now}),
             revoked_by = case when k.revoked_at is null then ${session.userId}::uuid else k.revoked_by end
       where k.tenant_id = ${session.tenantId} and ${subject} and k.id = ${keyId}
      returning k.id, k.owner_user_id, (k.revoked_at = ${now}) as newly
    `.execute(trx);
    const row = result.rows[0];
    if (!row) throw new ApiKeyNotFoundError("No such personal API key.");
    if (row.newly) {
      // The audit record is what the owner's notice and any later question
      // ("who cut my key off?") are answered from.
      await appendScopedEntityEventInTransaction(trx, {
        aggregateType: PERSONAL_API_KEY_AGGREGATE,
        aggregateId: row.id,
        eventType,
        payload: { ownerUserId: row.owner_user_id, actorUserId: session.userId, revokedAt: now.toISOString() },
      });
    }
    const read = await sql<KeyRow>`
      select ${METADATA_COLUMNS} from ${PAGE_FROM}
       where k.tenant_id = ${session.tenantId} and k.id = ${keyId}
    `.execute(trx);
    return listed(read.rows[0]!);
  });
}

/** Revoke one of the caller's own keys. */
export async function revokeMyPersonalKey(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  keyId: string,
  now: Date = new Date(),
): Promise<ListedPersonalKey> {
  assertMayHoldPersonalKeys(session);
  return revoke(deps, session, sql`k.owner_user_id = ${session.userId}`, keyId, "personal_api_key_revoked", now);
}

/** Revoke any person's key, as an administrator. */
export async function revokeOrganizationPersonalKey(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  keyId: string,
  now: Date = new Date(),
): Promise<ListedPersonalKey> {
  assertMayRevokePersonalKeys(session);
  return revoke(deps, session, sql`true`, keyId, "personal_api_key_revoked_by_administrator", now);
}

/**
 * Join the session the Operation dispatcher already opened — the verified
 * person, with their identity link and audit identity — or open the caller's
 * own. The same rule as the integration service (service.ts, withSession):
 * never run inside another principal's session.
 */
function withSession<T>(
  deps: PersonalKeyServiceDeps,
  session: PersonalKeySession,
  callback: (trx: never) => Promise<T>,
): Promise<T> {
  const active = activeDbSessionContext(deps.db);
  if (active && (active.tenantId !== session.tenantId || active.userId !== session.userId ||
    active.principalClass !== "person" || active.appPrincipalId !== null)) {
    throw new Error("Personal API key management cannot run inside another principal's database session.");
  }
  const input: DbSessionInput = active ?? {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: [...session.roles],
    groups: session.groups ? [...session.groups] : [],
    scope: "tenant",
    principalKind: "person",
  };
  return withDbSession(deps.db, input, (trx) => callback(trx as never));
}
