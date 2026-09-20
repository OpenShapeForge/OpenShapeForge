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
 * says so) and comes here. A trusted-context session only reads: it stands
 * for a person the bearer path admits, and the web host forwards the
 * person's token whenever it has one. An API-key session is a service
 * account nothing else would ever record, so on first use it writes what
 * it can — its own identity row and an empty pending link, under its own
 * session — and an administrator's `link_identity` or an invitation claims
 * that row.
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
import type { TrustedSessionContext } from "./trusted-context.js";

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
 * The link state of a service account (an API key's session): read first,
 * and only when nothing is there, its identity row and an empty pending
 * link are made — under its own session, which is the one the identities
 * policy lets write that subject. A service account never signs in
 * interactively, so nothing else would ever record it; an administrator's
 * `link_identity` or an invitation then claims the row.
 */
export async function ensureServiceIdentityLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  identity: SessionIdentity,
  displayName: string,
): Promise<IdentityLinkState | null> {
  if (!canHoldLink(session)) return null;
  return cachedRead(linkCacheKey(identity.issuer, identity.subject, session.tenantId), () =>
    withDbSession(db, session, async (trx) => {
      const existing = await readLinkRowByIdentity(trx, identity, session.tenantId);
      if (existing) return toState(existing, identity);
      const identityId = await upsertIdentity(trx, { ...identity, name: displayName }, displayName);
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
    }), "Recording the service account's identity");
}

/**
 * The acting Relation for a session that carries no token claims, filled
 * onto the session the resolver built so `sessionRelation(session)` answers
 * for every credential kind. A trusted-context session names a person whose
 * bearer login admitted them — the web host forwards the person's token for
 * exactly that — and only reads; an API-key session records its service
 * account on first use. A session that could be linked but names no realm
 * is a deployment that cannot say who acts: unavailable, never nobody.
 */
export async function withSessionRelation(
  session: TrustedSessionContext,
  options: { db?: OpenShapeForgeDatabase | undefined },
): Promise<TrustedSessionContext> {
  if (session.credential !== "trusted-context" && session.credential !== "api-key") return session;
  if (!options.db || !session.tenantId || !session.userId) return session;
  const link: SessionInput = {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: [...session.roles],
    groups: [...session.groups],
    scope: session.scope,
  };
  if (!canHoldLink(link)) return session;
  if (!session.issuer) {
    throw new SessionAuthenticationUnavailableError(
      "The session names no issuer, so its identity cannot be resolved; set OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER.",
    );
  }
  const identity = { issuer: session.issuer, subject: session.userId };
  const relation = session.credential === "api-key"
    ? await ensureServiceIdentityLink(options.db, link, identity, session.userDisplayName ?? session.userId)
    : await readSessionLink(options.db, link, identity);
  return {
    ...session,
    relation,
    ...(relation?.displayName && !session.userDisplayName ? { userDisplayName: relation.displayName } : {}),
  };
}
