// SPDX-License-Identifier: BUSL-1.1
/**
 * What a platform invitation actually did, said so that the assistant relaying
 * it cannot promise an e-mail that never goes out.
 *
 * Every invite result carries `delivery` (machine-readable), `signInUrl` (the
 * tenant's own address, built the same way as its MCP resource) and `nextStep`
 * (addressed to the language model: what to tell the person). The decision of
 * whether mail is sent is the shared one in auth/keycloak-invitation-delivery.ts.
 */
import { organizationMcpPath } from "../mcp/organization-resource.js";
import { deliverOrganizationInvitation, type InvitationDeliveryDecision } from "../auth/keycloak-invitation-delivery.js";
import { FirstAdministratorError } from "./first-administrator-error.js";
import type { FirstAdministratorClients } from "./first-tenant-administrator.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";

export type InvitationDelivery =
  | "email_sent"
  | "no_email_existing_account"
  | "already_pending"
  | "already_accepted";

/**
 * `<public origin>/<slug>`: the address that serves the tenant's app to a
 * browser (and its MCP to a client). Null when the deployment has no public
 * origin configured; read per call so tests and hosts cannot cache it.
 */
export function tenantSignInUrl(slug: string): string | null {
  const origin = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  return origin ? `${origin}${organizationMcpPath(slug)}` : null;
}

function signInAt(url: string | null): string {
  return url ? `sign in at ${url}` : "sign in to this tenant's app";
}

export function invitationOutcome(slug: string, delivery: InvitationDelivery) {
  const signInUrl = tenantSignInUrl(slug);
  const nextStep: Record<InvitationDelivery, string> = {
    email_sent:
      "Keycloak accepted the invitation e-mail request; inbox delivery is not confirmed. Tell the person to open that " +
      "e-mail and follow its link. If it does not arrive, offer resend_tenant_invitation.",
    no_email_existing_account:
      "No e-mail was sent and none will be: this person already has an account in this organization. Tell them to " +
      `${signInAt(signInUrl)}; the role is applied on that sign-in. Do not tell them to wait for mail.`,
    already_pending:
      "No new e-mail was sent: Keycloak already holds an invitation for this address (its delivery was never " +
      "confirmed). Ask whether the person received it; if not, offer resend_tenant_invitation and call it only once " +
      "they confirm.",
    already_accepted:
      `Nothing was sent: this person already accepted and is a member. Tell them to ${signInAt(signInUrl)}. ` +
      "Change their roles with assign_tenant_member_roles.",
  };
  return { delivery, signInUrl, nextStep: nextStep[delivery] };
}

/**
 * A 409 on invite-user that a fresh read does not explain, named for what
 * it means instead of the generic "delivery unconfirmed": no mail was
 * attempted. Keycloak's wording is the only signal left to go on.
 */
function invitationConflict(error: KeycloakAdminError): FirstAdministratorError {
  if (/already (a )?member/i.test(error.message)) {
    return new FirstAdministratorError(
      "ORGANIZATION_MEMBER_EXISTS",
      "Keycloak says this address is already an organization member, but the member list does not show it; no e-mail " +
        "was sent. Do not retry; check list_tenant_members for the account and report the mismatch.",
    );
  }
  if (/pending invitation/i.test(error.message)) {
    return new FirstAdministratorError(
      "INVITATION_ALREADY_PENDING",
      "Keycloak still holds an invitation for this address (it may have expired); no new e-mail was sent. Find it with " +
        "list_tenant_invitations, then resend it or revoke it and invite again.",
    );
  }
  return new FirstAdministratorError(
    "INVITATION_REJECTED",
    "Keycloak rejected the invitation for this address as conflicting; no e-mail was sent.",
  );
}

/**
 * The shared delivery decision (auth/keycloak-invitation-delivery.ts) in the
 * platform's words, with the SMTP preflight before any new e-mail and an
 * unexplained 409 named instead of blamed on mail delivery.
 */
export async function deliverInvitation(
  members: FirstAdministratorClients["members"],
  organizationId: string,
  input: { email: string; firstName?: string; lastName?: string },
  options: { knownNonMember?: boolean } = {},
): Promise<Exclude<InvitationDelivery, "already_accepted">> {
  try {
    const decision = await deliverOrganizationInvitation(members, organizationId, input, {
      ...options,
      beforeSend: async () => {
        if (!(await members.hasInvitationMailConfiguration())) {
          throw new FirstAdministratorError(
            "SMTP_NOT_CONFIGURED",
            "Configure working SMTP (host and sender) on the tenant Keycloak realm before sending invitations.",
          );
        }
      },
    });
    return PLATFORM_DELIVERY[decision];
  } catch (error) {
    if (error instanceof KeycloakAdminError && error.status === 409) throw invitationConflict(error);
    throw error;
  }
}

const PLATFORM_DELIVERY = {
  sent: "email_sent",
  not_required: "no_email_existing_account",
  already_pending: "already_pending",
} as const satisfies Record<InvitationDeliveryDecision, InvitationDelivery>;
