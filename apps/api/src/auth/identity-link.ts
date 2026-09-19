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
 *      path and linked, the invited role is granted on the audience client,
 *      and the invitation row moves to `accepted`. Without one, nothing is
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
 * Trusted-context and API key sessions carry no e-mail and are not people
 * signing in, so they never link; the accessor answers null for them.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  getGeneratedCrudTables,
} from "../graphql/generated-crud.js";
import { HttpError } from "../rest/http-error.js";
import { IDENTITY_LINK_ADMIN_ROLE, NEEDS_ROLE_ASSIGNMENT_ROLES } from "./organization-roles.js";
// This module and ./employee-invitations.ts import each other: an invitation
// is what admits a person (here), and admission is what accepts an invitation
// (there). The cycle is safe — every binding crossing it is read at call
// time, never during module evaluation — and splitting the two halves apart
// would put the admission rule and the table it reads in different files.
import { acceptInvitation, findPendingInvitation } from "./employee-invitations.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";

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
 * no link), or a session that cannot link at all (trusted-context, API key).
 */
export function sessionRelation(
  session: { relation?: IdentityLinkState | null | undefined } | null | undefined,
): SessionRelation | null {
  const link = session?.relation;
  if (!link || link.status !== "linked" || !link.relationId) return null;
  return { relationId: link.relationId, displayName: link.displayName };
}

/** Flatten the claims a verified token carries about the person. */
export function identityClaimsFromToken(
  claims: Record<string, unknown>,
): IdentityClaims | null {
  const issuer = stringClaim(claims.iss);
  const subject = stringClaim(claims.sub);
  if (!issuer || !subject) return null;
  return {
    issuer,
    subject,
    email: stringClaim(claims.email),
    name: stringClaim(claims.name),
    givenName: stringClaim(claims.given_name),
    familyName: stringClaim(claims.family_name),
    preferredUsername: stringClaim(claims.preferred_username),
  };
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The person's display name, in the order the token is trusted for it. */
export function displayNameFromClaims(claims: IdentityClaims): string {
  const combined = [claims.givenName, claims.familyName].filter(Boolean).join(" ").trim();
  return claims.name ?? (combined || undefined) ?? claims.preferredUsername ?? claims.subject;
}

/**
 * First/last name for the NaturalPerson row, or null when the token does not
 * say. Both are required on NaturalPerson and neither is guessed: a person
 * with only a username gets a Relation, not a person record with an invented
 * family name.
 */
export function personNameFromClaims(
  claims: IdentityClaims,
): { firstName: string; lastName: string } | null {
  if (claims.givenName && claims.familyName) {
    return { firstName: claims.givenName, lastName: claims.familyName };
  }
  const parts = (claims.name ?? "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache and single-flight
//
// Every request resolves a session, so the link is read once per request
// without this. Linked and pending states are cached briefly; a change made
// through this module invalidates its own key, and a change made by another
// replica shows up within the TTL. Concurrent first requests of one person
// share one in-flight resolution so the just-in-time path creates one
// Relation, not one per parallel request.

const LINK_CACHE_TTL_MS = 60_000;
const linkCache = new Map<string, { state: IdentityLinkState; expiresAtMs: number }>();
const inFlight = new Map<string, Promise<IdentityLinkState | null>>();

function cacheKey(issuer: string, subject: string, tenantId: string): string {
  return `${issuer}\n${subject}\n${tenantId}`;
}

export function invalidateIdentityLink(issuer: string, subject: string, tenantId: string): void {
  linkCache.delete(cacheKey(issuer, subject, tenantId));
}

/** Test-only. */
export function __resetIdentityLinkForTests(): void {
  linkCache.clear();
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Resolution (just in time)

type SessionInput = DbSessionInput & { tenantId: string; userId: string };

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
  const key = cacheKey(claims.issuer, claims.subject, session.tenantId);
  const cached = linkCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.state;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    try {
      const state = await ensureIdentityLink(db, session, claims);
      if (state) {
        linkCache.set(key, { state, expiresAtMs: Date.now() + LINK_CACHE_TTL_MS });
      }
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

  if (found.state) {
    // A pending row that names no Relation AND no candidate is not a person
    // waiting to confirm something — it is the empty session this module now
    // refuses to hand out. It happens for a token with no e-mail claim: the
    // row is kept so `link_identity` can find the identity, but until an
    // administrator links it, this is a no.
    if (
      found.state.status === "pending_confirmation" &&
      !found.state.relationId &&
      !found.state.candidateRelationId &&
      !found.knownToTenant
    ) {
      throw notInvited(session, claims);
    }
    return found.state;
  }

  // Phase 2: nobody in this tenant carries this e-mail. Being able to sign in
  // to the realm is NOT admission — see this module's header. An organization
  // administrator must have invited this address, and that invitation is what
  // gets created and linked below.
  const invitation = claims.email
    ? await withDbSession(db, session, (trx) =>
        findPendingInvitation(trx, session.tenantId, claims.email!),
      )
    : null;
  if (!invitation) throw notInvited(session, claims);

  // Invited: create the person as a Relation. Through the generated CRUD path
  // (role-ungated variant: this is a runtime surface acting for a person who
  // may hold no Relations role), so the rows get the same defaults, events and
  // projections a REST create would.
  const relationId = await createPersonRelation(db, session, claims, displayName);
  if (!relationId) return null;

  const linked = await withDbSession(db, session, async (trx) => {
    const inserted = await insertLinkRow(trx, {
      identityId: found.identityId,
      tenantId: session.tenantId,
      status: "linked",
      relationId,
      candidateRelationId: null,
      linkedBy: "jit",
      // Cleared by acceptInvitation below, which records the invited roles on
      // this row. The person's own session may insert the row but may not
      // write `roles` (trigger in db/migrations/identity-link.ts).
      needsRoleAssignment: true,
    });
    if (inserted) {
      console.info(
        `[auth] Linked identity ${found.identityId} (${claims.subject}) to new Relation ` +
          `${relationId} "${displayName}" in tenant ${session.tenantId} (just in time, on ` +
          `invitation ${invitation.id}).`,
      );
    }
    // Lost a race with another replica: keep its link, ours stays an ordinary
    // unlinked Relation an administrator can clean up.
    const row = inserted ?? (await readLinkRow(trx, found.identityId, session.tenantId));
    return row ? toState(row, claims) : null;
  });
  if (!linked) return null;

  // The roles they were invited as, recorded on this row for this tenant and
  // effective on this very session: the token never carried them and never
  // will, so there is no grant to wait for and no window to bridge.
  const accepted = await acceptInvitation(db, session, invitation, found.identityId);
  invalidateIdentityLink(claims.issuer, claims.subject, session.tenantId);
  return { ...linked, needsRoleAssignment: false, roles: accepted.roles };
}

/** The refusal, worded so the person knows what has to happen next. */
function notInvited(session: SessionInput, claims: IdentityClaims): NotInvitedError {
  console.warn(
    `[auth] Refused ${claims.email ?? claims.subject} (${claims.issuer}) in tenant ` +
      `${session.tenantId}: nobody in this organization carries that e-mail and no ` +
      "invitation is pending.",
  );
  return new NotInvitedError(
    claims.email
      ? `${claims.email} has not been invited to this organization. Being able to sign in is ` +
        "not enough on its own: an organization administrator invites you by e-mail " +
        "(invite_employee), and you follow the link in that mail. Ask an administrator of " +
        "this organization to invite this address, then sign in again."
      : "This sign-in carries no e-mail address, so it cannot be matched to an invitation or " +
        "to anybody in this organization. An organization administrator has to link it " +
        "explicitly (link_identity) before it can be used here.",
  );
}

async function createPersonRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
  displayName: string,
): Promise<string | null> {
  const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  const relations = tables.get("erp.relations");
  if (!relations) {
    console.warn("[auth] This deployment has no Relation entity; identities stay unlinked.");
    return null;
  }
  const relation = await createGeneratedEntityForTable(db, session, relations, {
    displayName,
    relationType: "person",
    status: "active",
  });
  const relationId = String(relation.id);

  const persons = tables.get("erp.natural_persons");
  const personName = personNameFromClaims(claims);
  if (persons && personName) {
    await createGeneratedEntityForTable(db, session, persons, {
      ...personName,
      relationId,
    });
  }
  const contactDetails = tables.get("erp.contact_details");
  if (contactDetails && claims.email) {
    await createGeneratedEntityForTable(db, session, contactDetails, {
      relationId,
      type: "email",
      value: claims.email,
      isPrimary: true,
      status: "active",
    });
  }
  return relationId;
}

// ---------------------------------------------------------------------------
// Explicit linking

/**
 * The person confirms the candidate the just-in-time path recorded for them.
 * Only ever links the SESSION's own identity, and only to its recorded
 * candidate — there is no argument to point it elsewhere.
 */
export async function confirmPendingLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput & { relation?: IdentityLinkState | null | undefined },
): Promise<IdentityLinkState> {
  const current = session.relation;
  if (!current) {
    throw new HttpError(
      409,
      "NO_IDENTITY_LINK",
      "This session carries no identity to confirm; sign in with a bearer token.",
    );
  }
  if (current.status === "linked") {
    throw new HttpError(409, "ALREADY_LINKED", "You are already linked to a Relation.");
  }
  if (!current.candidateRelationId) {
    throw new HttpError(
      409,
      "NO_CANDIDATE",
      "There is no candidate Relation to confirm; ask an organization administrator to link you.",
    );
  }
  const state = await withDbSession(db, session, async (trx) => {
    const row = await readLinkRow(trx, current.identityId, session.tenantId);
    if (!row || row.status !== "pending_confirmation" || !row.candidate_relation_id) {
      throw new HttpError(409, "NO_CANDIDATE", "There is no pending candidate to confirm any more.");
    }
    await sql`
      update platform.identity_relations
         set status = 'linked',
             relation_id = ${row.candidate_relation_id},
             candidate_relation_id = null,
             linked_at = now(),
             linked_by = ${current.identityId},
             updated_at = now()
       where identity_id = ${current.identityId}
         and tenant_id = ${session.tenantId}
    `.execute(trx);
    const updated = await readLinkRow(trx, current.identityId, session.tenantId);
    if (!updated) throw new HttpError(500, "INTERNAL", "The link vanished while confirming it.");
    return toState(updated, current);
  });
  console.info(
    `[auth] Identity ${state.identityId} confirmed its link to Relation ${state.relationId} ` +
      `in tenant ${session.tenantId}.`,
  );
  invalidateIdentityLink(state.issuer, state.subject, session.tenantId);
  session.relation = state;
  return state;
}

export type LinkIdentityInput = {
  /** E-mail of the identity to link (as its identity provider reports it). */
  identityEmail?: string | undefined;
  /** Or the identity id, e.g. from a pending row. */
  identityId?: string | undefined;
  relationId: string;
};

/**
 * An organization administrator links an identity to a Relation of the
 * tenant. The identity must be known here — it has signed in to this tenant
 * before (linked or pending) — which is also what the RLS on
 * platform.identities lets the administrator see. Re-linking an already
 * linked identity is allowed: the previous Relation is left as it is.
 */
export async function linkIdentityToRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput & { relation?: IdentityLinkState | null | undefined },
  input: LinkIdentityInput,
): Promise<IdentityLinkState> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Linking identities requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  const actor = session.relation?.identityId ?? session.userId;
  const email = input.identityEmail?.trim();
  if (!email && !input.identityId) {
    throw new HttpError(400, "VALIDATION", "Give identityEmail or identityId.");
  }
  if (!UUID_PATTERN.test(input.relationId)) {
    throw new HttpError(400, "VALIDATION", "relationId must be a UUID.");
  }
  if (input.identityId && !UUID_PATTERN.test(input.identityId)) {
    throw new HttpError(400, "VALIDATION", "identityId must be a UUID.");
  }

  const state = await withDbSession(db, session, async (trx) => {
    const identities = await sql<{
      id: string;
      issuer: string;
      subject: string;
      email: string | null;
      display_name: string | null;
    }>`
      select i.id, i.issuer, i.subject, i.email, i.display_name
        from platform.identities i
       where ${
         input.identityId
           ? sql`i.id = ${input.identityId}`
           : sql`lower(i.email) = lower(${email ?? ""})`
       }
         and exists (
           select 1 from platform.identity_relations ir
            where ir.identity_id = i.id and ir.tenant_id = ${session.tenantId}
         )
       order by i.created_at
    `.execute(trx);
    if (identities.rows.length === 0) {
      throw new HttpError(
        404,
        "IDENTITY_NOT_FOUND",
        "No identity with that e-mail has signed in to this organization yet.",
      );
    }
    if (identities.rows.length > 1) {
      throw new HttpError(
        409,
        "IDENTITY_AMBIGUOUS",
        "Several identities carry that e-mail; pass identityId instead.",
      );
    }
    const identity = identities.rows[0]!;

    const relation = await sql<{ id: string; display_name: string }>`
      select id, display_name from erp.relations
       where id = ${input.relationId} and tenant_id = ${session.tenantId}
    `.execute(trx);
    if (relation.rows.length === 0) {
      throw new HttpError(404, "RELATION_NOT_FOUND", "No such Relation in this organization.");
    }

    await sql`
      insert into platform.identity_relations
        (identity_id, tenant_id, status, relation_id, candidate_relation_id, linked_at, linked_by)
      values
        (${identity.id}, ${session.tenantId}, 'linked', ${input.relationId}, null, now(), ${actor})
      on conflict (identity_id, tenant_id) do update
        set status = 'linked',
            relation_id = excluded.relation_id,
            candidate_relation_id = null,
            linked_at = now(),
            linked_by = excluded.linked_by,
            updated_at = now()
    `.execute(trx);
    const row = await readLinkRow(trx, identity.id, session.tenantId);
    if (!row) throw new HttpError(500, "INTERNAL", "The link vanished while writing it.");
    return toState(row, { issuer: identity.issuer, subject: identity.subject });
  });
  console.info(
    `[auth] ${actor} linked identity ${state.identityId} to Relation ${state.relationId} ` +
      `in tenant ${session.tenantId}.`,
  );
  invalidateIdentityLink(state.issuer, state.subject, session.tenantId);
  if (session.relation?.identityId === state.identityId) session.relation = state;
  return state;
}

// ---------------------------------------------------------------------------
// SQL

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LinkRow = {
  identity_id: string;
  issuer: string;
  subject: string;
  status: IdentityLinkStatus;
  relation_id: string | null;
  candidate_relation_id: string | null;
  linked_by: string | null;
  display_name: string | null;
  relation_type: string | null;
  needs_role_assignment: boolean;
  roles: string[] | null;
};

async function upsertIdentity(
  trx: Transaction<DB>,
  claims: IdentityClaims,
  displayName: string,
): Promise<string> {
  const result = await sql<{ id: string }>`
    insert into platform.identities (issuer, subject, email, display_name)
    values (${claims.issuer}, ${claims.subject}, ${claims.email ?? null}, ${displayName})
    on conflict (issuer, subject) do update
      set email = coalesce(excluded.email, platform.identities.email),
          display_name = coalesce(excluded.display_name, platform.identities.display_name),
          updated_at = case
            when excluded.email is distinct from platform.identities.email
              or excluded.display_name is distinct from platform.identities.display_name
            then now() else platform.identities.updated_at end
    returning id
  `.execute(trx);
  return result.rows[0]!.id;
}

async function readLinkRow(
  trx: Transaction<DB>,
  identityId: string,
  tenantId: string,
): Promise<LinkRow | null> {
  const result = await sql<LinkRow>`
    select ir.identity_id, i.issuer, i.subject, ir.status, ir.relation_id,
           ir.candidate_relation_id, ir.linked_by, ir.needs_role_assignment, ir.roles,
           coalesce(linked.display_name, candidate.display_name) as display_name,
           coalesce(linked.relation_type, candidate.relation_type) as relation_type
      from platform.identity_relations ir
      join platform.identities i on i.id = ir.identity_id
      left join erp.relations linked
        on linked.id = ir.relation_id and linked.tenant_id = ir.tenant_id
      left join erp.relations candidate
        on candidate.id = ir.candidate_relation_id and candidate.tenant_id = ir.tenant_id
     where ir.identity_id = ${identityId} and ir.tenant_id = ${tenantId}
  `.execute(trx);
  return result.rows[0] ?? null;
}

async function insertLinkRow(
  trx: Transaction<DB>,
  row: {
    identityId: string;
    tenantId: string;
    status: IdentityLinkStatus;
    relationId: string | null;
    candidateRelationId: string | null;
    linkedBy: string | null;
    needsRoleAssignment?: boolean;
  },
): Promise<LinkRow | null> {
  const inserted = await sql<{ identity_id: string }>`
    insert into platform.identity_relations
      (identity_id, tenant_id, status, relation_id, candidate_relation_id, linked_at, linked_by,
       needs_role_assignment)
    values
      (${row.identityId}, ${row.tenantId}, ${row.status}, ${row.relationId},
       ${row.candidateRelationId},
       ${row.status === "linked" ? sql`now()` : null}, ${row.linkedBy},
       ${row.needsRoleAssignment ?? false})
    on conflict (identity_id, tenant_id) do nothing
    returning identity_id
  `.execute(trx);
  if (inserted.rows.length === 0) return null;
  return readLinkRow(trx, row.identityId, row.tenantId);
}

async function relationsWithEmail(
  trx: Transaction<DB>,
  tenantId: string,
  email: string,
): Promise<Array<{ id: string; display_name: string }>> {
  const result = await sql<{ id: string; display_name: string }>`
    select distinct r.id, r.display_name
      from erp.relations r
      join erp.contact_details cd
        on cd.relation_id = r.id and cd.tenant_id = r.tenant_id
     where r.tenant_id = ${tenantId}
       and lower(cd.type) = 'email'
       and lower(cd.value) = lower(${email})
  `.execute(trx);
  return result.rows;
}

function toState(row: LinkRow, identity: { issuer: string; subject: string }): IdentityLinkState {
  const roles = [...new Set(row.roles ?? [])].sort();
  return {
    identityId: row.identity_id,
    issuer: row.issuer ?? identity.issuer,
    subject: row.subject ?? identity.subject,
    status: row.status,
    relationId: row.relation_id,
    displayName: row.display_name,
    relationType: row.relation_type,
    candidateRelationId: row.candidate_relation_id,
    linkedBy: row.linked_by,
    // A linked member with no roles here — confirmed a candidate, or linked
    // by an administrator, without ever being invited as anything — is
    // waiting for a role exactly as a JIT-created one whose invitation could
    // not be recorded. Derived, so the two cannot disagree.
    needsRoleAssignment:
      row.needs_role_assignment || (row.status === "linked" && roles.length === 0),
    roles,
  };
}

// ---------------------------------------------------------------------------
// Org-admin: pending role assignment

export type PendingRoleAssignment = {
  identityId: string;
  relationId: string;
  displayName: string | null;
  email: string | null;
  /** When this identity first signed in and got JIT-linked (linked_at). */
  firstSignInAt: string;
};

/**
 * Identities in this tenant awaiting a real role — `list_pending_members`:
 * linked here, but holding no roles here (see `toState`). Gated the same way
 * `linkIdentityToRelation` is: the caller must hold
 * Organization.All.ReadWrite. Ordered oldest first, so the longest-waiting
 * new hire surfaces first.
 */
export async function listPendingRoleAssignments(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
): Promise<PendingRoleAssignment[]> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Listing pending members requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{
      identity_id: string;
      relation_id: string;
      display_name: string | null;
      email: string | null;
      linked_at: string;
    }>`
      select ir.identity_id, ir.relation_id, r.display_name, i.email, ir.linked_at
        from platform.identity_relations ir
        join platform.identities i on i.id = ir.identity_id
        join erp.relations r on r.id = ir.relation_id and r.tenant_id = ir.tenant_id
       where ir.tenant_id = ${session.tenantId}
         and (ir.needs_role_assignment or cardinality(ir.roles) = 0)
         and ir.status = 'linked'
       order by ir.linked_at asc
    `.execute(trx);
    return result.rows.map((row) => ({
      identityId: row.identity_id,
      relationId: row.relation_id,
      displayName: row.display_name,
      email: row.email,
      firstSignInAt: row.linked_at,
    }));
  });
}

/**
 * `set_member_role`: record the roles an identity holds in THIS tenant and
 * clear `needs_role_assignment`. Replaces the whole set rather than adding to
 * it, so demoting an administrator to an employee is the same call as the
 * promotion. Gated on `IDENTITY_LINK_ADMIN_ROLE` here and again by the
 * trigger on the column, which refuses the write from any session without
 * that role in `app.roles`. Scoped to this tenant by RLS; the identity must
 * already have a row here (it signed in, or was linked by an administrator).
 *
 * Takes effect on the person's next request on this replica: the cache entry
 * is invalidated below, and other replicas pick it up within
 * LINK_CACHE_TTL_MS. No sign-out is needed — the token never carried these.
 */
export async function setMembershipRoles(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  identityId: string,
  roles: readonly string[],
): Promise<IdentityLinkState> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Assigning roles requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  const state = await withDbSession(db, session, async (trx) => {
    await sql`
      update platform.identity_relations
         -- Bound as jsonb and unpacked: the driver serialises a JS array as
         -- JSON for a jsonb parameter but not as a PostgreSQL array literal.
         set roles = (
           select coalesce(array_agg(value), '{}'::text[])
             from jsonb_array_elements_text(${[...new Set(roles)].sort()}::jsonb)
         ),
             needs_role_assignment = false,
             updated_at = now()
       where identity_id = ${identityId}
         and tenant_id = ${session.tenantId}
    `.execute(trx);
    const row = await readLinkRow(trx, identityId, session.tenantId);
    if (!row) {
      throw new HttpError(
        404,
        "IDENTITY_NOT_FOUND",
        "No such identity has a link in this organization.",
      );
    }
    return toState(row, { issuer: row.issuer, subject: row.subject });
  });
  invalidateIdentityLink(state.issuer, state.subject, session.tenantId);
  return state;
}

/** Resolve a relationId to its linked identityId in this tenant, for `set_member_role`. */
export async function identityIdForRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  relationId: string,
): Promise<string | null> {
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ identity_id: string }>`
      select identity_id from platform.identity_relations
       where tenant_id = ${session.tenantId} and relation_id = ${relationId} and status = 'linked'
    `.execute(trx);
    return result.rows[0]?.identity_id ?? null;
  });
}
