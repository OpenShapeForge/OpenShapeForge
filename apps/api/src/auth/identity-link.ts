// SPDX-License-Identifier: BUSL-1.1
/**
 * The link between a login and a party.
 *
 * A bearer token proves an IDENTITY: who, at which identity provider
 * (`iss` + `sub`). What the organization cares about is the PARTY that
 * identity acts as — a Relation of the tenant: the employee, the supplier
 * contact, the customer contact. Which of those the person is, is a
 * RelationRole on that Relation; the link itself says only "this login is
 * that Relation".
 *
 * Identity is platform-level (one Keycloak account signs in to several
 * tenants), the party is per tenant, so the link is per (identity, tenant):
 * platform.identities and platform.identity_relations
 * (db/migrations/identity-link.ts).
 *
 * AN INVITATION IS THE ONLY WAY IN
 * ---------------------------------------------------------------------------
 * Holding a valid token for the realm is NOT enough. A Google Workspace
 * account of the customer's is a token this realm will happily mint, and it
 * used to be enough: the just-in-time path below created a Relation for
 * anybody whose e-mail nobody in the tenant carried, so every colleague of
 * every customer could walk in. That branch now refuses (`NotInvitedError`,
 * 403 NOT_INVITED) unless `platform.employee_invitations` holds a PENDING row
 * for `(tenant_id, lower(email))` — an organization administrator's
 * deliberate `invite_employee`. The refusal says who can let them in, because
 * a person who was simply forgotten needs to know what to ask for, and the
 * alternative failure (an authenticated session with no Relation, where half
 * the surface works) is worse than a clear no.
 *
 * Three ways a link comes about:
 *
 *   1. Just in time, on the first session in a tenant (`resolveIdentityLink`,
 *      called from identity.ts on the bearer path). If NO Relation in the
 *      tenant carries the token's e-mail, there must be a pending invitation:
 *      a Relation of type person is then created through the generated CRUD
 *      path and linked, the invited roles are recorded on the membership
 *      row for this tenant, and the invitation is claimed — all in one
 *      transaction (identity-link-admission.ts). Without one, nothing is
 *      created and the request is refused. If a Relation DOES carry the
 *      e-mail, nothing is linked silently and no invitation is needed: the
 *      row is recorded as `pending_confirmation` with the Relation as
 *      candidate, and stays that way until the person confirms. (Somebody
 *      already put that person in the tenant's own records; the question
 *      there is "is this you", not "may you be here".)
 *   2. The person confirms the pending candidate (`confirmPendingLink`, MCP
 *      tool confirm_my_link).
 *   3. An organization administrator links an identity to a Relation
 *      explicitly (`linkIdentityToRelation`, MCP tool link_identity).
 *
 * The result rides on the session as `session.relation`; `sessionRelation()`
 * is the accessor every other surface should read it through.
 *
 * THE ROW ALSO CARRIES THE PERSON'S ROLES IN THIS TENANT
 * ---------------------------------------------------------------------------
 * `platform.identity_relations.roles` is the organization-scoped grant: what
 * an invitation admitted the person as, or what `set_member_role` later
 * assigned — for this (identity, tenant) and no other. identity.ts unions it
 * onto the session for the tenant the token selected. One Keycloak account
 * that is a member of several organizations therefore holds a separate role
 * set in each; the identity provider carries membership, never the roles.
 * Nothing here writes a Keycloak client role to the user any more: such a
 * role is user-wide, and a grant made by organization A's administrator
 * would have applied in organization B too.
 *
 * Every session kind links through the same row. A trusted-context session
 * names a person whose bearer login made the identity row and admitted them
 * (the web host forwards the person's token for exactly that): it only
 * reads the link, by its issuer (the realm this deployment trusts) and its
 * user id, which is the identity subject. An API-key session is a service
 * account that never signs in interactively: its first session records its
 * own identity row and an empty pending link, so an administrator's
 * `link_identity` can make the integration act as a Relation like anyone
 * else, and an invitation can claim that row. Both live in
 * ./identity-link-session.ts. `sessionRelation()` is the one accessor for
 * all of them, and answers null until a link is made.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { __resetIdentityLinkCacheForTests, cachedLinkState, invalidateIdentityLink, linkCacheKey, linkGeneration, storeLinkState, type SessionInput } from "./identity-link-session.js";
import { HttpError } from "../rest/http-error.js";
import { IDENTITY_LINK_ADMIN_ROLE, NEEDS_ROLE_ASSIGNMENT_ROLES } from "./organization-roles.js";
// This module and ./employee-invitations.ts import each other: an invitation
// is what admits a person (here), and admission is what accepts an invitation
// (there). The cycle is safe — every binding crossing it is read at call
// time, never during module evaluation — and splitting the two halves apart
// would put the admission rule and the table it reads in different files.
import { findPendingInvitation } from "./employee-invitations.js";
import { acceptPendingInvitation, admitInvitedPerson, notInvited } from "./identity-link-admission.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";
import {
  insertLinkRow,
  readLinkRow,
  relationsWithEmail,
  toState,
  upsertIdentity,
} from "./identity-link-store.js";

// Both re-exported so every existing importer of this module keeps working;
// they live in ./organization-roles.ts because a `const` may not cross the
// cycle with ./employee-invitations.ts. See that file.
export { IDENTITY_LINK_ADMIN_ROLE, NEEDS_ROLE_ASSIGNMENT_ROLES };

/**
 * A verified token whose person this tenant has never heard of and nobody
 * invited. Thrown out of `resolveIdentityLink` — the ONE failure this module
 * does not swallow, because swallowing it is exactly the hole this class
 * closes. identity.ts re-throws it so the request surfaces as 403 NOT_INVITED
 * with the message below, rather than as a session that authenticates and
 * then half-works.
 */
export class NotInvitedError extends HttpError {
  constructor(message: string) {
    super(403, "NOT_INVITED", message);
    this.name = "NotInvitedError";
  }
}

/** What the token says about the person. Shaped by `identityClaimsFromToken`. */
export type IdentityClaims = {
  issuer: string;
  subject: string;
  email?: string | undefined;
  name?: string | undefined;
  givenName?: string | undefined;
  familyName?: string | undefined;
  preferredUsername?: string | undefined;
};

export type IdentityLinkStatus = "linked" | "pending_confirmation";

/** The full per-(identity, tenant) state, as carried on the session. */
export type IdentityLinkState = {
  identityId: string;
  issuer: string;
  subject: string;
  status: IdentityLinkStatus;
  /** Set when linked. */
  relationId: string | null;
  /** Display name of the linked Relation (or of the candidate while pending). */
  displayName: string | null;
  /**
   * `relation_type` of the linked Relation (or of the candidate while
   * pending): "person" for a just-in-time link, whatever an administrator
   * linked otherwise. Null when neither exists.
   */
  relationType: string | null;
  /** Set while pending, when the e-mail matched exactly one Relation. */
  candidateRelationId: string | null;
  linkedBy: string | null;
  /**
   * True only for a Relation the just-in-time path CREATED (no existing
   * Relation in this tenant carried the token's e-mail). See
   * db/migrations/identity-link.ts for why this — and not a Keycloak
   * admin-API role grant at creation time — is what a brand-new identity's
   * very first session can act on.
   */
  needsRoleAssignment: boolean;
  /**
   * The roles this identity holds in THIS tenant (see the module header).
   * identity.ts unions them onto the session; empty until an invitation was
   * accepted or an administrator ran `set_member_role`.
   */
  roles: readonly string[];
};

/** What a linked session resolves to: the party the login acts as. */
export type SessionRelation = {
  relationId: string;
  displayName: string | null;
};

/**
 * The Relation a session is linked to, or null: not linked yet (pending, or
 * no link). Every session kind carries the link the same way — the bearer
 * path resolves it with the token's claims, a trusted-context or API-key
 * session reads it by its user id (`readSessionLink`) — so this is the one
 * place anything that acts as a Relation asks.
 */
export function sessionRelation(
  session: { relation?: IdentityLinkState | null | undefined } | null | undefined,
): SessionRelation | null {
  const link = session?.relation;
  if (!link || link.status !== "linked" || !link.relationId) return null;
  return { relationId: link.relationId, displayName: link.displayName };
}

// The token's claims about the person (issuer, subject, e-mail, name) are
// read in ./identity-claims.ts; re-exported so every importer keeps one address.
export { displayNameFromClaims, identityClaimsFromToken, personNameFromClaims } from "./identity-claims.js";
import { displayNameFromClaims } from "./identity-claims.js";

// ---------------------------------------------------------------------------
// Single-flight
//
// Concurrent first requests of one person share one in-flight resolution so
// the just-in-time path creates one Relation, not one per parallel request.
// The cache itself lives in ./identity-link-session.ts, shared with the
// session-side reads, so a link made on either path is seen by both.

const inFlight = new Map<string, Promise<IdentityLinkState | null>>();

export { invalidateIdentityLink, type SessionInput } from "./identity-link-session.js";

/** Test-only. */
export function __resetIdentityLinkForTests(): void {
  inFlight.clear();
  __resetIdentityLinkCacheForTests();
}

/**
 * The link state for this session's identity in this tenant, creating it
 * just in time on the first session — but only for somebody this tenant
 * invited or already knows.
 *
 * Throws {@link NotInvitedError} for a refusal and
 * {@link SessionAuthenticationUnavailableError} for a FAILURE (a statement
 * timeout, an exhausted pool). The failure is not swallowed: this row is what
 * says whether the tenant admitted the person and which roles they hold
 * here, so a session produced without it would authenticate an uninvited
 * realm user on whatever the token happens to carry. Fail closed, 503.
 */
export async function resolveIdentityLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
): Promise<IdentityLinkState | null> {
  const key = linkCacheKey(claims.issuer, claims.subject, session.tenantId);
  // Only a linked state is settled; anything else (pending, a candidate, a
  // session-side "no row") is an admission question this path must ask again.
  const cached = cachedLinkState(key);
  if (cached?.state?.status === "linked") return cached.state;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    // Snapshotted before the read: an administrator's link_identity that
    // lands while this runs bumps the generation, and this result is then
    // not stored over it.
    const generation = linkGeneration(key);
    try {
      const state = await ensureIdentityLink(db, session, claims);
      if (state) storeLinkState(key, generation, state);
      return state;
    } catch (error) {
      if (error instanceof NotInvitedError) throw error;
      if (error instanceof SessionAuthenticationUnavailableError) throw error;
      console.warn(
        "[auth] Resolving the identity ↔ Relation link failed; refusing the session (503):",
        error instanceof Error ? error.message : String(error),
      );
      throw new SessionAuthenticationUnavailableError(
        "The identity link could not be resolved; try again.",
      );
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, work);
  return work;
}

async function ensureIdentityLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
): Promise<IdentityLinkState | null> {
  const displayName = displayNameFromClaims(claims);

  // Phase 1: the identity row, and the link if there is one.
  const found = await withDbSession(db, session, async (trx) => {
    const identityId = await upsertIdentity(trx, claims, displayName);
    // Is there a Relation in this tenant with the token's e-mail? Asked even
    // when a link row already exists, because it is also the admission
    // question for an identity that only ever got an empty pending row.
    const candidates = claims.email
      ? await relationsWithEmail(trx, session.tenantId, claims.email)
      : [];

    const existing = await readLinkRow(trx, identityId, session.tenantId);
    if (existing) {
      return { identityId, state: toState(existing, claims), knownToTenant: candidates.length > 0 };
    }

    if (candidates.length > 0 || !claims.email) {
      // Somebody may already be this Relation — do not decide for them. And
      // without an e-mail there is nothing to match on, so an administrator
      // has to link explicitly; the row exists so they can find the identity.
      const candidate = candidates.length === 1 ? candidates[0]! : null;
      const inserted = await insertLinkRow(trx, {
        identityId,
        tenantId: session.tenantId,
        status: "pending_confirmation",
        relationId: null,
        candidateRelationId: candidate?.id ?? null,
        linkedBy: null,
      });
      const row = inserted ?? (await readLinkRow(trx, identityId, session.tenantId));
      return {
        identityId,
        state: row ? toState(row, claims) : null,
        knownToTenant: candidates.length > 0,
      };
    }
    return { identityId, state: null, knownToTenant: false };
  });

  // A pending row that names no Relation AND no candidate is not a person
  // waiting to confirm something: it is what a session that could not be
  // admitted by an e-mail recorded (an API key's, a token without one), kept
  // so `link_identity` can find the identity. It settles nothing — phase 2
  // asks the invitation question for it exactly as for no row at all.
  const emptyPending = found.state !== null &&
    found.state.status === "pending_confirmation" &&
    !found.state.relationId &&
    !found.state.candidateRelationId &&
    !found.knownToTenant;
  if (found.state && !emptyPending) {
    // A linked member with no roles here and a still-pending invitation: the
    // acceptance did not land when the link was made (a 503 on the way), or an
    // administrator linked them by hand while an invitation was open. Accept
    // now, so a person invited as an administrator does not stay on the
    // just-in-time minimum until somebody notices.
    if (found.state.status === "linked" && found.state.roles.length === 0 && claims.email) {
      const invitation = await withDbSession(db, session, (trx) =>
        findPendingInvitation(trx, session.tenantId, claims.email!),
      );
      if (invitation) {
        const roles = await acceptPendingInvitation(db, session, invitation, found.identityId);
        invalidateIdentityLink(claims.issuer, claims.subject, session.tenantId);
        if (roles) return { ...found.state, needsRoleAssignment: false, roles };
      }
    }
    return found.state;
  }

  // Phase 2: nobody in this tenant carries this e-mail, and any row there is
  // is empty. Being able to sign in to the realm is NOT admission — see this
  // module's header. An organization administrator must have invited this
  // address, and that invitation is what gets created and linked below (an
  // empty pending row is claimed by it).
  const invitation = claims.email
    ? await withDbSession(db, session, (trx) =>
        findPendingInvitation(trx, session.tenantId, claims.email!),
      )
    : null;
  if (!invitation) throw notInvited(session, claims);

  // Invited: the Relation, the link with the invited roles and the claim of
  // the invitation, in one transaction (identity-link-admission.ts).
  return admitInvitedPerson(db, session, claims, found.identityId, invitation);
}

// The SQL lives in ./identity-link-store.ts and the explicit-linking and
// administration half in ./identity-link-admin.ts; both re-exported so every
// importer keeps one address.
export { readLinkRow, toState, writeMembershipRoles, type LinkRow } from "./identity-link-store.js";
export { ensureServiceIdentityLink, readSessionLink, withSessionRelation, type SessionIdentity } from "./identity-link-session.js";
// The explicit-linking and administration half lives in
// ./identity-link-admin.ts; re-exported so every importer keeps one address.
export {
  confirmPendingLink,
  identityIdForRelation,
  linkIdentityToRelation,
  listPendingRoleAssignments,
  listUnlinkedIdentities,
  setMembershipRoles,
  type LinkIdentityInput,
  type PendingRoleAssignment,
  type UnlinkedIdentity,
} from "./identity-link-admin.js";
