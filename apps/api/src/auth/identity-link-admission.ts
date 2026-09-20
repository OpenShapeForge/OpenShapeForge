// SPDX-License-Identifier: BUSL-1.1
/**
 * Admission of an invited person on first sign-in — the persistence half of
 * the just-in-time path in ./identity-link.ts.
 *
 * ONE elevated transaction does everything: the person's Relation (with its
 * NaturalPerson and e-mail contact, through the generated CRUD path so the
 * rows get the same defaults, events and projections a REST create would),
 * the link row with the invited roles, and the claim of the invitation. The
 * session is deliberately elevated to `Organization.All.ReadWrite`: the
 * invitation table's write policy and the trigger on
 * `identity_relations.roles` both demand it, and the person signing in has
 * nothing of the sort — it is the RUNTIME recording, on behalf of the
 * administrator who invited, that the invitation has now been used. One
 * transaction, so there is no state in which the Relation exists without the
 * link, the link without the roles, or the roles without the invitation
 * being spent — a failure anywhere leaves nothing behind, and the next
 * sign-in starts over.
 *
 * The invitation is CLAIMED, not re-read: `claimPendingInvitation` flips the
 * row from pending to accepted and returns the role it holds at that moment.
 * An administrator who revoked it or changed its role between the lookup and
 * this transaction wins — no row comes back and the person is refused, or
 * the changed role is what gets recorded.
 */
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  getGeneratedCrudTables,
} from "../graphql/generated-crud.js";
import {
  claimPendingInvitation,
  employeeInvitationRoleGrants,
  type PendingInvitationMatch,
} from "./employee-invitations.js";
import {
  actingPartyTable,
  IDENTITY_CONTRACT,
  loginContactTable,
  personTable,
} from "./identity-contract.js";
import {
  displayNameFromClaims,
  invalidateIdentityLink,
  NotInvitedError,
  personNameFromClaims,
  type IdentityClaims,
  type IdentityLinkState,
} from "./identity-link.js";
import { insertLinkRow, linkEmptyPendingRow, readLinkRow, toState, writeMembershipRoles } from "./identity-link-store.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "./organization-roles.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";

type SessionInput = DbSessionInput & { tenantId: string; userId: string };

/** The session the runtime records admission on. One object, so nested database work reuses the transaction. */
function elevated(session: SessionInput): SessionInput {
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: [IDENTITY_LINK_ADMIN_ROLE],
    groups: [...(session.groups ?? [])],
    scope: session.scope ?? null,
  };
}

/**
 * Create the person's Relation, link it with the invited roles and claim the
 * invitation. Throws {@link NotInvitedError} when the invitation is no longer
 * pending by the time it is claimed.
 */
export async function admitInvitedPerson(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
  identityId: string,
  invitation: PendingInvitationMatch,
): Promise<IdentityLinkState> {
  const displayName = displayNameFromClaims(claims);
  const runtime = elevated(session);
  const linked = await withDbSession(db, runtime, async (trx) => {
    const role = await claimPendingInvitation(trx, session.tenantId, invitation.id);
    if (!role) throw notInvited(session, claims);
    const roles = employeeInvitationRoleGrants(role);
    const relationId = await createPersonRelation(db, runtime, claims, displayName);
    const inserted = await insertLinkRow(trx, {
      identityId,
      tenantId: session.tenantId,
      status: "linked",
      relationId,
      candidateRelationId: null,
      linkedBy: "jit",
      roles,
    }) ?? (
      // The row may already exist, empty and pending: a session that could
      // not be admitted by an e-mail (an API key's, a token without one)
      // recorded it. The invitation claims that row rather than losing to it.
      await linkEmptyPendingRow(trx, { identityId, tenantId: session.tenantId, relationId, linkedBy: "jit", roles })
        ? await readLinkRow(trx, identityId, session.tenantId)
        : null
    );
    if (inserted) {
      console.info(
        `[auth] Linked identity ${identityId} (${claims.subject}) to new Relation ` +
          `${relationId} "${displayName}" in tenant ${session.tenantId} (just in time, on ` +
          `invitation ${invitation.id}; holds ${role} here).`,
      );
    }
    // Lost a race with another replica: keep its link; this transaction's
    // Relation and claim roll back with the refusal below.
    const row = inserted ?? (await readLinkRow(trx, identityId, session.tenantId));
    return row ? toState(row, claims) : null;
  });
  if (!linked) {
    throw new SessionAuthenticationUnavailableError(
      "The identity link vanished while it was being written; try again.",
    );
  }
  invalidateIdentityLink(claims.issuer, claims.subject, session.tenantId);
  return linked;
}

/**
 * Record the invited roles on an EXISTING linked row and claim the
 * invitation — the retry for a link that holds no roles while an invitation
 * is still pending. Null when the invitation was no longer pending.
 */
export async function acceptPendingInvitation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  invitation: PendingInvitationMatch,
  identityId: string,
): Promise<readonly string[] | null> {
  const roles = await withDbSession(db, elevated(session), async (trx) => {
    const role = await claimPendingInvitation(trx, session.tenantId, invitation.id);
    if (!role) return null;
    const granted = employeeInvitationRoleGrants(role);
    if (!(await writeMembershipRoles(trx, session.tenantId, identityId, granted))) {
      throw new SessionAuthenticationUnavailableError("The identity link vanished while accepting; try again.");
    }
    return [...new Set(granted)].sort();
  });
  if (roles) {
    console.info(
      `[auth] ${session.userId} accepted invitation ${invitation.id} in tenant ` +
        `${session.tenantId}; holds (${roles.join(", ")}) here.`,
    );
  }
  return roles;
}

/** The refusal, worded so the person knows what has to happen next. */
export function notInvited(session: SessionInput, claims: IdentityClaims): NotInvitedError {
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
  const { actingParty, person, loginContact } = IDENTITY_CONTRACT;
  const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  const relations = tables.get(actingPartyTable());
  if (!relations) {
    throw new SessionAuthenticationUnavailableError(
      `This deployment has no ${actingParty.entity} entity; identities cannot be admitted.`,
    );
  }
  const relation = await createGeneratedEntityForTable(db, session, relations, {
    [actingParty.nameField]: displayName,
    [actingParty.typeField]: actingParty.personType,
    [actingParty.statusField]: actingParty.activeStatus,
  });
  const relationId = String(relation.id);

  const persons = tables.get(personTable());
  const personName = personNameFromClaims(claims);
  if (persons && personName) {
    await createGeneratedEntityForTable(db, session, persons, {
      [person.firstNameField]: personName.firstName,
      [person.lastNameField]: personName.lastName,
      [person.relationField]: relationId,
    });
  }
  const contactDetails = tables.get(loginContactTable());
  if (contactDetails && claims.email) {
    await createGeneratedEntityForTable(db, session, contactDetails, {
      [loginContact.relationField]: relationId,
      [loginContact.typeField]: loginContact.emailType,
      [loginContact.valueField]: claims.email,
      [loginContact.primaryField]: true,
      [loginContact.statusField]: loginContact.activeStatus,
    });
  }
  return relationId;
}
