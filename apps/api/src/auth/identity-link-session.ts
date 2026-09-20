// SPDX-License-Identifier: BUSL-1.1
/**
 * The identity ↔ Relation link as a session sees it, and the one cache both
 * resolvers share.
 *
 * Every session kind links through the same platform.identity_relations row.
 * The bearer path (identity-link.ts, resolveIdentityLink) resolves it with
 * the token's claims and admits the person; a session without token claims
 * — trusted-context, an API key — names its identity by its issuer and its
 * user id (which IS the identity subject: the identities visibility policy
 * says so) and comes here. Such a session cannot be admitted by an e-mail
 * it does not carry, so it records what it can: its own identity row and,
 * in this tenant, an empty pending link — under its own session, which is
 * the one the identities policy lets write that subject. A person's later
 * bearer login finds that row and admits them through it; an integration's
 * service account is linked by an administrator's `link_identity`.
 *
 * One cache, keyed (issuer, subject, tenant), TTL a minute, versioned: every
 * write and every invalidation bumps the key's generation, and a read stores
 * only under the generation it snapshotted first — a stale state can neither
 * land after an invalidation nor overwrite what the other path just wrote.
 */
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { UUID_PATTERN, withDbSession, type DbSessionInput } from "../db/session.js";
import { insertLinkRow, readLinkRow, readLinkRowByIdentity, toState, upsertIdentity } from "./identity-link-store.js";
import type { IdentityLinkState } from "./identity-link.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";

export type SessionInput = DbSessionInput & { tenantId: string; userId: string };
export type SessionIdentity = { issuer: string; subject: string };

const LINK_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { state: IdentityLinkState | null; expiresAtMs: number }>();
const generations = new Map<string, number>();

export function linkCacheKey(issuer: string, subject: string, tenantId: string): string {
  return `${issuer}\n${subject}\n${tenantId}`;
}

export function linkGeneration(key: string): number {
  return generations.get(key) ?? 0;
}

function bump(key: string): number {
  const next = linkGeneration(key) + 1;
  generations.set(key, next);
  return next;
}

/** The cached state for a key, when one is fresh. `undefined` is a miss; a cached `null` is a hit that says "no row". */
export function cachedLinkState(key: string): { state: IdentityLinkState | null } | undefined {
  const cached = cache.get(key);
  return cached && cached.expiresAtMs > Date.now() ? { state: cached.state } : undefined;
}

/** Store a state read or written under `generation`; a newer generation wins and the store is skipped. */
export function storeLinkState(key: string, generation: number, state: IdentityLinkState | null): void {
  if (linkGeneration(key) !== generation) return;
  cache.set(key, { state, expiresAtMs: Date.now() + LINK_CACHE_TTL_MS });
}

/** A write through either path: the row changed, so every reader restarts from the database. */
export function recordLinkWrite(key: string, state: IdentityLinkState | null): void {
  bump(key);
  cache.set(key, { state, expiresAtMs: Date.now() + LINK_CACHE_TTL_MS });
}

export function invalidateIdentityLink(issuer: string, subject: string, tenantId: string): void {
  const key = linkCacheKey(issuer, subject, tenantId);
  cache.delete(key);
  bump(key);
}

/** Test-only. */
export function __resetIdentityLinkCacheForTests(): void {
  cache.clear();
  generations.clear();
}

/** A tenant or user that is not a uuid can hold no link: the tables key on uuids. */
export function canHoldLink(session: SessionInput): boolean {
  return UUID_PATTERN.test(session.tenantId) && UUID_PATTERN.test(session.userId);
}

async function cachedRead(
  key: string,
  read: () => Promise<IdentityLinkState | null>,
  what: string,
): Promise<IdentityLinkState | null> {
  const hit = cachedLinkState(key);
  if (hit) return hit.state;
  const generation = linkGeneration(key);
  try {
    const state = await read();
    storeLinkState(key, generation, state);
    return state;
  } catch (error) {
    console.warn(
      `[auth] ${what} failed; refusing the session (503):`,
      error instanceof Error ? error.message : String(error),
    );
    throw new SessionAuthenticationUnavailableError("The identity link could not be read; try again.");
  }
}

/**
 * The link state of the identity (issuer, subject) names, read under the
 * session's own policies, never created. Null when no linked or pending
 * row exists. A failure to read it is a 503, as on the bearer path.
 */
export async function readSessionLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  identity: SessionIdentity,
): Promise<IdentityLinkState | null> {
  if (!canHoldLink(session)) return null;
  return cachedRead(linkCacheKey(identity.issuer, identity.subject, session.tenantId), async () => {
    const row = await withDbSession(db, session, (trx) => readLinkRowByIdentity(trx, identity, session.tenantId));
    return row ? toState(row, identity) : null;
  }, "Reading the session's identity ↔ Relation link");
}

/**
 * The link state of a session that carries no token claims, its identity
 * row and an empty pending link made on first use when absent (see the
 * module header). `displayName` names a new identity row; null leaves a
 * name a bearer login recorded untouched.
 */
export async function ensureSessionIdentityLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  identity: SessionIdentity,
  displayName: string | null,
): Promise<IdentityLinkState | null> {
  if (!canHoldLink(session)) return null;
  return cachedRead(linkCacheKey(identity.issuer, identity.subject, session.tenantId), () =>
    withDbSession(db, session, async (trx) => {
      const identityId = await upsertIdentity(trx, { ...identity, ...(displayName ? { name: displayName } : {}) }, displayName);
      const existing = await readLinkRow(trx, identityId, session.tenantId);
      if (existing) return toState(existing, identity);
      const inserted = await insertLinkRow(trx, {
        identityId,
        tenantId: session.tenantId,
        status: "pending_confirmation",
        relationId: null,
        candidateRelationId: null,
        linkedBy: null,
      });
      const row = inserted ?? (await readLinkRow(trx, identityId, session.tenantId));
      return row ? toState(row, identity) : null;
    }), "Recording the session's identity");
}
