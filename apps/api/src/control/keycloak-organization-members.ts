// SPDX-License-Identifier: BUSL-1.1
/**
 * Inviting a person into a Keycloak Organization,
 * `POST /admin/realms/{realm}/organizations/{orgId}/members/invite-user`.
 *
 * ── VERIFIED AGAINST THE RUNNING KEYCLOAK 26.5.3 ─────────────────────────────
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
 * record. There is no partial state to clean up on that failure; the caller
 * just has to say plainly that the deployment's mail configuration is what
 * failed, not the invitation itself. Wiring a local SMTP relay (or a
 * catch-all like Mailpit) into the realm is what makes this endpoint usable
 * in a given environment at all; that is deployment configuration, not
 * something this module can route around.
 *
 * ── WHY THERE IS NO list/cancel HERE ─────────────────────────────────────────
 *
 * Keycloak exposes NO way to enumerate or cancel a pending invitation:
 * confirmed by inviting an address and then listing
 * `/organizations/{id}/members` and `/users?email=...`/`/users?search=...` —
 * none of them list it, and no user or member resource is created until the
 * person accepts. It DOES still dedupe internally — re-inviting the same
 * address to the same organization answers `409 {"errorMessage":"User
 * already has a pending invitation"}` — so some state exists server-side,
 * it is simply not addressable through any admin-API resource this module
 * could read or delete. Practically: there is nothing here to list or revoke
 * on the Keycloak side, and revoking on the Hubble side (below) cannot make
 * Keycloak itself forget it invited that address — a second `invite_employee`
 * call for the same e-mail before the original action token's own expiry will
 * still 409 upstream even though Hubble shows no pending row any more.
 * `auth/employee-invitations.ts` is the actual system of record for "who was
 * invited, with what role, by whom" (`platform.employee_invitations`); see
 * that module's header for how the gap is presented to an administrator.
 */
import {
  createServiceAccountTokenProvider,
  describeError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig,
  type ServiceAccountTokenProvider,
} from "./keycloak-service-account.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";

export type InviteOrganizationMemberInput = {
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

export type KeycloakOrganizationMembersClient = {
  /**
   * Invite `input.email` into the organization. Resolves on Keycloak's `204`;
   * throws {@link KeycloakAdminError} otherwise, including
   * `KEYCLOAK_ADMIN_REJECTED` for the realm's own mail-delivery failure (the
   * body names it explicitly, and the message here repeats that rather than
   * inventing a different explanation).
   */
  inviteUser(organizationId: string, input: InviteOrganizationMemberInput): Promise<void>;
};

export type KeycloakOrganizationMembersOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Shared with the other Keycloak admin clients so one token serves all. */
  tokens?: ServiceAccountTokenProvider;
};

export function createKeycloakOrganizationMembersClient(
  config: KeycloakServiceAccountConfig,
  options: KeycloakOrganizationMembersOptions = {},
): KeycloakOrganizationMembersClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const adminBase = `${config.baseUrl}/admin/realms/${encodeURIComponent(config.tenantRealm)}/organizations`;

  const tokens =
    options.tokens ??
    createServiceAccountTokenProvider(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      unauthorized: (message, status) =>
        new KeycloakAdminError("KEYCLOAK_ADMIN_UNAUTHORIZED", message, status),
      unavailable: (message, status) =>
        new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", message, status),
    });

  return {
    async inviteUser(organizationId, input) {
      const url = `${adminBase}/${encodeURIComponent(organizationId)}/members/invite-user`;
      const body = new URLSearchParams({ email: input.email });
      if (input.firstName) body.set("firstName", input.firstName);
      if (input.lastName) body.set("lastName", input.lastName);

      const token = await tokens.get();
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_UNAVAILABLE",
          `Could not reach the Keycloak admin API at ${url}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }

      if (response.status === 204 || response.ok) return;
      const responseBody = await readJson(response);

      if (response.status === 401 || response.status === 403) {
        tokens.invalidate();
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_UNAUTHORIZED",
          `The Keycloak admin API refused "${config.clientId}" inviting a member: ` +
            `${describeError(responseBody, response.statusText)}. The service account must hold ` +
            "realm-management manage-realm.",
          response.status,
        );
      }
      if (response.status === 404) {
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND",
          "The Keycloak organization this tenant is linked to no longer exists.",
          response.status,
        );
      }
      if (response.status === 400 || response.status === 409) {
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_REJECTED",
          `The Keycloak admin API rejected the invitation: ` +
            describeError(responseBody, response.statusText),
          response.status,
        );
      }
      // Includes the realm's own 500 "Failed to send invite email" — a
      // deployment fault (SMTP is not configured on this realm), not
      // something the caller's input can fix, so it is classified the same
      // way an unreachable Keycloak would be, with the realm's own message
      // carried through rather than redacted.
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAVAILABLE",
        `The Keycloak admin API could not send the invitation: ` +
          describeError(responseBody, response.statusText),
        response.status,
      );
    },
  };
}
