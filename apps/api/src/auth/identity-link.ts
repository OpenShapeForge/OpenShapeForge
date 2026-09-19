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
import {
  employeeInvitationRoleGrants,
  findPendingInvitation,
  recordAcceptedInvitation,
  type PendingInvitationMatch,
} from "./employee-invitations.js";
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

export type SessionInput = DbSessionInput & { tenantId: string; userId: string };

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
        const roles = await acceptOnElevatedSession(db, session, invitation, found.identityId);
        invalidateIdentityLink(claims.issuer, claims.subject, session.tenantId);
        return { ...found.state, needsRoleAssignment: false, roles };
      }
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

  // The link, its roles and the invitation's acceptance land in ONE
  // transaction, on a deliberately elevated session: the trigger on `roles`
  // and the invitation table's write policy both demand
  // Organization.All.ReadWrite, which the person signing in does not hold —
  // it is the runtime recording, on behalf of the administrator who invited,
  // that the invitation has now been used. One transaction, so there is no
  // state in which the person is linked but the roles they were invited as
  // are not on the row.
  const roles = employeeInvitationRoleGrants(invitation.role);
  const linked = await withDbSession(
    db,
    { ...session, roles: [IDENTITY_LINK_ADMIN_ROLE] },
    async (trx) => {
      const inserted = await insertLinkRow(trx, {
        identityId: found.identityId,
        tenantId: session.tenantId,
        status: "linked",
        relationId,
        candidateRelationId: null,
        linkedBy: "jit",
        roles,
      });
      if (inserted) {
        await recordAcceptedInvitation(trx, session.tenantId, invitation);
        console.info(
          `[auth] Linked identity ${found.identityId} (${claims.subject}) to new Relation ` +
            `${relationId} "${displayName}" in tenant ${session.tenantId} (just in time, on ` +
            `invitation ${invitation.id}; holds ${invitation.role} here).`,
        );
      }
      // Lost a race with another replica: keep its link, ours stays an ordinary
      // unlinked Relation an administrator can clean up.
      const row = inserted ?? (await readLinkRow(trx, found.identityId, session.tenantId));
      return row ? toState(row, claims) : null;
    },
  );
  if (!linked) {
    throw new SessionAuthenticationUnavailableError(
      "The identity link vanished while it was being written; try again.",
    );
  }
  invalidateIdentityLink(claims.issuer, claims.subject, session.tenantId);
  return linked;
}

/** `recordAcceptedInvitation` plus the roles on the row, as one elevated transaction. */
async function acceptOnElevatedSession(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  invitation: PendingInvitationMatch,
  identityId: string,
): Promise<readonly string[]> {
  const roles = employeeInvitationRoleGrants(invitation.role);
  await withDbSession(db, { ...session, roles: [IDENTITY_LINK_ADMIN_ROLE] }, async (trx) => {
    await writeMembershipRoles(trx, session.tenantId, identityId, roles);
    await recordAcceptedInvitation(trx, session.tenantId, invitation);
  });
  console.info(
    `[auth] ${session.userId} accepted invitation ${invitation.id} in tenant ` +
      `${session.tenantId}; holds ${invitation.role} here (${roles.join(", ")}).`,
  );
  return [...new Set(roles)].sort();
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

/**
 * The person as a Relation. A deployment without the Relation entity cannot
 * admit anybody: there is nothing to link and nothing to hold roles, and a
 * session without the membership record would run on the token alone — so
 * that is an unavailability, not a session.
 */
async function createPersonRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
  displayName: string,
): Promise<string> {
  const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  const relations = tables.get("erp.relations");
  if (!relations) {
    throw new SessionAuthenticationUnavailableError(
      "This deployment has no Relation entity; identities cannot be admitted.",
    );
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
// SQL

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LinkRow = {
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

export async function readLinkRow(
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

/** The roles column, bound as jsonb and unpacked: the driver serialises a JS
 * array as JSON for a jsonb parameter but not as a PostgreSQL array literal. */
function rolesArray(roles: readonly string[]) {
  return sql`(
    select coalesce(array_agg(value), '{}'::text[])
      from jsonb_array_elements_text(${[...new Set(roles)].sort()}::jsonb)
  )`;
}

/** Write `roles` for (identity, tenant); the caller's session must pass the column's trigger. */
export async function writeMembershipRoles(
  trx: Transaction<DB>,
  tenantId: string,
  identityId: string,
  roles: readonly string[],
): Promise<void> {
  await sql`
    update platform.identity_relations
       set roles = ${rolesArray(roles)},
           needs_role_assignment = false,
           updated_at = now()
     where identity_id = ${identityId}
       and tenant_id = ${tenantId}
  `.execute(trx);
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
    /** Only on an elevated session: the column's trigger refuses it otherwise. */
    roles?: readonly string[];
  },
): Promise<LinkRow | null> {
  const inserted = await sql<{ identity_id: string }>`
    insert into platform.identity_relations
      (identity_id, tenant_id, status, relation_id, candidate_relation_id, linked_at, linked_by,
       needs_role_assignment, roles)
    values
      (${row.identityId}, ${row.tenantId}, ${row.status}, ${row.relationId},
       ${row.candidateRelationId},
       ${row.status === "linked" ? sql`now()` : null}, ${row.linkedBy},
       false, ${rolesArray(row.roles ?? [])})
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

export function toState(row: LinkRow, identity: { issuer: string; subject: string }): IdentityLinkState {
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


// The explicit-linking and administration half lives in
// ./identity-link-admin.ts; re-exported so every importer keeps one address.
export {
  confirmPendingLink,
  identityIdForRelation,
  linkIdentityToRelation,
  listPendingRoleAssignments,
  setMembershipRoles,
  type LinkIdentityInput,
  type PendingRoleAssignment,
} from "./identity-link-admin.js";
