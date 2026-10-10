// SPDX-License-Identifier: BUSL-1.1
/**
 * A person's invitation into a Keycloak Organization: sending one
 * (`POST /admin/realms/{realm}/organizations/{orgId}/members/invite-user`),
 * enumerating the ones still pending, and un-sending one
 * (`GET`/`DELETE /admin/realms/{realm}/organizations/{orgId}/invitations`).
 *
 * ── SENDING: VERIFIED AGAINST THE RUNNING KEYCLOAK 26.5.3 ────────────────────
 *
 * The endpoint takes `application/x-www-form-urlencoded` (`email` required,
 * `firstName`/`lastName` optional), not JSON — confirmed by exercising it
 * directly against the local realm. On success it answers `204 No Content`
 * and mails an action-token link the person accepts (their Keycloak account is
 * created only when they click it — see below). There is a second endpoint,
 * `invite-existing-user`, for a person who already has an account in the
 * realm; this module only calls `invite-user` because the runtime invites by
 * e-mail address alone and has no reason to know in advance whether the
 * person already signed in elsewhere.
 *
 * `invite-user` genuinely REQUIRES a working realm SMTP configuration: with
 * `smtpServer` empty (the out-of-the-box local realm), the call answers
 * `500 {"errorMessage":"Failed to send invite email"}` and — this is the
 * important half — creates NEITHER a Keycloak user NOR any member/invitation
 * record: `GET /organizations/{id}/invitations` stays `[]` afterwards. There is
 * no partial state to clean up on that failure; the caller just has to say
 * plainly that the deployment's mail configuration is what failed, not the
 * invitation itself. Wiring a local SMTP relay (or a catch-all like Mailpit)
 * into the realm is what makes this endpoint usable in a given environment at
 * all; that is deployment configuration, not something this module can route
 * around.
 *
 * ── LISTING AND CANCELLING: ALSO VERIFIED AGAINST 26.5.3 ─────────────────────
 *
 * A pending invitation IS an addressable admin resource, and this module reads
 * and deletes it. Measured by hand against the running realm, with a throwaway
 * SMTP sink so `invite-user` actually succeeds:
 *
 *   - `GET /organizations/{id}/invitations` answers `200` with one row per
 *     pending invitation — `{id, organizationId, email, firstName, lastName,
 *     sentDate, expiresAt, status:"PENDING", inviteLink}`. `sentDate` and
 *     `expiresAt` are epoch SECONDS, not milliseconds, and are carried through
 *     as Keycloak reports them rather than silently rescaled.
 *   - `DELETE /organizations/{id}/invitations/{invitationId}` answers `204`,
 *     and the listing is `[]` immediately after.
 *   - That DELETE really UN-SENDS. Opening the link that was already delivered
 *     to the person's inbox afterwards answers HTTP `400` on Keycloak's own
 *     login page: "The link you clicked is no longer valid. It may have expired
 *     or already been used." So cancelling is not bookkeeping on this side —
 *     the mail already out there stops working.
 *   - The DELETE also FREES THE ADDRESS. `409 {"errorMessage":"User already
 *     has a pending invitation"}` is raised only while an invitation is
 *     pending; inviting the very same address again after the DELETE answers
 *     `204` once more. A revoke followed by a fresh invite therefore works end
 *     to end, with no waiting for the original action token to expire.
 *   - A repeat DELETE — and an id the realm never issued — answers
 *     `404 {"errorMessage":"Invitation not found"}`.
 *     {@link KeycloakOrganizationMembersClient.deleteInvitation} reports that
 *     as `false` rather than throwing: the invitation is gone, which is exactly
 *     what the caller asked for, and only the wording of the answer differs.
 *
 * `inviteLink` is present in every listed row and is DELIBERATELY DROPPED by
 * {@link KeycloakOrganizationInvitation}. It embeds a signed ORGIVT action
 * token whose `jti` is the invitation id, and anyone who can read that URL can
 * redeem it — accepting the invitation as that person. A log line, an MCP tool
 * response and a GraphQL field are all places it must never reach, and the only
 * way to guarantee that is to not carry it out of this module at all. The
 * person who was invited already has the link, in their inbox.
 *
 * No Keycloak USER and no MEMBER resource exists until the person accepts:
 * while an invitation was pending, `GET /users?email=...` answered `[]` and the
 * organization's `/members` did not list it either. The invitations resource
 * above is the only place a pending invitation is visible on the Keycloak side.
 *
 * `auth/employee-invitations.ts` remains the system of record for what Keycloak
 * does not model — which role the person was invited into, and by whom
 * (`platform.employee_invitations`). What it is no longer is the only place a
 * revoke can act: it now cancels the Keycloak invitation as well, which is what
 * makes the delivered link dead and the address invitable again.
 */
import type { ServiceAccountTokenProvider } from "./keycloak-service-account.js";
import type { KeycloakAdminError } from "./keycloak-organization-admin-types.js";
export type InviteOrganizationMemberInput = {
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

/**
 * One pending invitation as `GET /organizations/{id}/invitations` reports it.
 *
 * `inviteLink` is deliberately NOT part of this type — see the module header:
 * it is a redeemable action token, and dropping it here is what keeps it out of
 * logs and tool responses.
 */
export type KeycloakOrganizationInvitation = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Keycloak's own status string; "PENDING" is the only one observed on 26.5.3. */
  status: string | null;
  /** Epoch SECONDS (not ms) as Keycloak reports them. */
  sentDate: number | null;
  expiresAt: number | null;
};

export type KeycloakOrganizationMembersClient = {
  /** Whether this address already belongs to the organization, compared case-insensitively. */
  hasMemberByEmail(organizationId: string, email: string): Promise<boolean>;
  /**
   * Invite `input.email` into the organization. Resolves on Keycloak's `204`;
   * throws {@link KeycloakAdminError} otherwise, including
   * `KEYCLOAK_ADMIN_REJECTED` for the `409` raised while an invitation to the
   * same address is still pending, and `KEYCLOAK_ADMIN_UNAVAILABLE` for the
   * realm's own mail-delivery failure (the body names it explicitly, and the
   * message here repeats that rather than inventing a different explanation).
   */
  inviteUser(organizationId: string, input: InviteOrganizationMemberInput): Promise<void>;
  /**
   * Mail an organization invitation to an address that already belongs to the
   * organization (Keycloak `invite-existing-user`), so a person given a new role
   * hears about it through the realm's own mail. Resolves false when no member
   * has this address.
   */
  inviteExistingMember?(organizationId: string, email: string): Promise<boolean>;
  /** Re-send the same pending invitation without accepting new recipient or role input. */
  resendInvitation?(organizationId: string, invitationId: string): Promise<void>;
  /**
   * The invitations the organization still has outstanding. An organization
   * with none answers an empty array, not an error.
   */
  listInvitations(organizationId: string): Promise<KeycloakOrganizationInvitation[]>;
  /**
   * Un-send one invitation. Resolves `true` when Keycloak actually cancelled
   * it, `false` when there was nothing left to cancel (`404 Invitation not
   * found` — already accepted, already cancelled, or never issued). Both are
   * converged outcomes; the boolean exists so the caller can word its answer as
   * "the invitation has been withdrawn" or "there was no invitation left to
   * withdraw" instead of guessing.
   */
  deleteInvitation(organizationId: string, invitationId: string): Promise<boolean>;
  /**
   * The pending invitation for `email`, or `null`. Keycloak has no lookup by
   * address, so this is the listing plus a case-insensitive compare — which is
   * the right comparison, because the realm treats addresses case-insensitively
   * and would answer `409` for an address that differs only in case.
   */
  findPendingInvitationByEmail(
    organizationId: string,
    email: string,
  ): Promise<KeycloakOrganizationInvitation | null>;
};

export type KeycloakTenantMemberAdminClient = KeycloakOrganizationMembersClient & {
  /** The organization's members as Keycloak knows them: identity facts only. A member's roles in the tenant are the tenant's own record (auth/identity-link.ts), never read from here. */
  listMembers(organizationId: string): Promise<KeycloakOrganizationMember[]>;
  getMember(organizationId: string, userId: string): Promise<KeycloakOrganizationMember | null>;
  /** Linked provider aliases only, after organization membership has been proved.
   * No broker subject, upstream username, tokens or realm provider configuration.
   * Missing capability is unavailable, never an empty provider list.
   */
  listFederatedIdentities?(organizationId: string, userId: string): Promise<{ alias: string }[]>;
  listCredentials(userId: string): Promise<KeycloakMemberCredential[]>;
  deleteCredential(userId: string, credentialId: string): Promise<boolean>;
  removeMember(organizationId: string, userId: string): Promise<boolean>;
  sendPasskeyRecovery(userId: string): Promise<void>;
  sendPasswordRecovery?(userId: string): Promise<void>;
};

export type KeycloakOrganizationMember = {
  memberId: string;
  username: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enabled: boolean;
  emailVerified: boolean;
};

export type KeycloakMemberCredential = {
  credentialId: string;
  type: string;
  label: string | null;
  createdAt: number | null;
};

export type KeycloakOrganizationMembersOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Shared with the other Keycloak admin clients so one token serves all. */
  tokens?: ServiceAccountTokenProvider;
};

export type OrganizationBootstrapReads = {
  hasInvitationMailConfiguration(): Promise<boolean>;
  organizationAdministrators(organizationId: string, clientId: string, role: string): Promise<{ email: string | null }[]>;
};
