// SPDX-License-Identifier: BUSL-1.1
/**
 * The one decision both admission surfaces share — the tenant's own
 * `invite_employee` and the platform's `create_tenant_invitation` /
 * `invite_first_tenant_admin`: does this address need an invitation e-mail?
 *
 *   not_required    — the address already belongs to the Keycloak Organization;
 *                     Keycloak would refuse invite-user, and the local admission
 *                     record is all their next sign-in needs.
 *   already_pending — Keycloak holds a reusable (PENDING, unexpired) invitation;
 *                     nothing new is sent.
 *   sent            — Keycloak accepted a new invite-user request.
 *
 * A 409 from invite-user is re-read, because a concurrent sign-up or invitation
 * can land in between; a 409 the re-read does not explain is rethrown as the
 * original {@link KeycloakAdminError} for the caller to name.
 */
import { KeycloakAdminError } from "../control/keycloak-organization-admin.js";
import type {
  InviteOrganizationMemberInput,
  KeycloakOrganizationInvitation,
  KeycloakOrganizationMembersClient,
} from "../control/keycloak-organization-members.js";

export type InvitationDeliveryDecision = "sent" | "not_required" | "already_pending";

export function isReusableInvitation(invitation: KeycloakOrganizationInvitation | null): boolean {
  return invitation?.status?.toUpperCase() === "PENDING" &&
    invitation.expiresAt !== null &&
    invitation.expiresAt >= Math.floor(Date.now() / 1000);
}

export async function deliverOrganizationInvitation(
  keycloak: KeycloakOrganizationMembersClient,
  organizationId: string,
  input: InviteOrganizationMemberInput,
  options: {
    /** Skip the membership read when the caller has just established there is no account. */
    knownNonMember?: boolean;
    /** Runs only when a new e-mail is about to be requested (an SMTP preflight). */
    beforeSend?: () => Promise<void>;
  } = {},
): Promise<InvitationDeliveryDecision> {
  if (!options.knownNonMember && await keycloak.hasMemberByEmail(organizationId, input.email)) return "not_required";
  if (isReusableInvitation(await keycloak.findPendingInvitationByEmail(organizationId, input.email))) {
    return "already_pending";
  }
  await options.beforeSend?.();
  try {
    await keycloak.inviteUser(organizationId, input);
    return "sent";
  } catch (error) {
    if (!(error instanceof KeycloakAdminError) || error.status !== 409) throw error;
    if (await keycloak.hasMemberByEmail(organizationId, input.email)) return "not_required";
    // Keycloak's own 409 says an invitation blocks this address, so any listed
    // one counts here, even one without an expiry the check above requires.
    if (await keycloak.findPendingInvitationByEmail(organizationId, input.email)) return "already_pending";
    throw error;
  }
}
