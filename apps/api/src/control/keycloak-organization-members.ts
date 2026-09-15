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
import {
  createServiceAccountTokenProvider,
  createKeycloakFetch,
  describeError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig,
  type ServiceAccountTokenProvider,
} from "./keycloak-service-account.js";
import {
  KeycloakAdminError,
  type KeycloakAdminOperation,
} from "./keycloak-organization-admin.js";

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
  /**
   * Invite `input.email` into the organization. Resolves on Keycloak's `204`;
   * throws {@link KeycloakAdminError} otherwise, including
   * `KEYCLOAK_ADMIN_REJECTED` for the `409` raised while an invitation to the
   * same address is still pending, and `KEYCLOAK_ADMIN_UNAVAILABLE` for the
   * realm's own mail-delivery failure (the body names it explicitly, and the
   * message here repeats that rather than inventing a different explanation).
   */
  inviteUser(organizationId: string, input: InviteOrganizationMemberInput): Promise<void>;
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createKeycloakOrganizationMembersClient(
  config: KeycloakServiceAccountConfig,
  options: KeycloakOrganizationMembersOptions = {},
): KeycloakOrganizationMembersClient & OrganizationBootstrapReads {
  const doFetch = createKeycloakFetch(config, options.fetch ?? globalThis.fetch);
  const now = options.now ?? (() => Date.now());
  const realmBase = `${config.baseUrl}/admin/realms/${encodeURIComponent(config.tenantRealm)}`;
  const adminBase = `${realmBase}/organizations`;

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

  function invitationsUrl(organizationId: string): string {
    return `${adminBase}/${encodeURIComponent(organizationId)}/invitations`;
  }

  /**
   * One request shape for all three calls: the same token, the same timeout,
   * and the same mapping of Keycloak's status onto {@link KeycloakAdminError}.
   * `what` is the gerund that names the call in the operator-facing message
   * ("inviting a member", "listing the pending invitations", …), so a failure
   * says which of the three failed without three copies of the mapping drifting
   * apart.
   *
   * `notFoundIsAnswer` is the one place they differ. Everywhere else a `404`
   * means the organization this tenant is linked to is gone — real drift. On
   * `DELETE .../invitations/{id}` it means the invitation is gone, which is the
   * outcome the caller wanted, so that status is returned instead of thrown.
   */
  async function request(
    url: string,
    init: RequestInit,
    what: string,
    operation: KeycloakAdminOperation,
    notFoundIsAnswer = false,
  ): Promise<{ status: number; body: unknown }> {
    const tokenStartedAt = now();
    let token: string;
    try {
      token = await tokens.get();
    } catch (error) {
      if (error instanceof KeycloakAdminError && error.operation === undefined) {
        throw new KeycloakAdminError(error.code, error.message, error.status, {
          operation: "service_account_token",
          durationMs: Math.max(0, now() - tokenStartedAt),
        });
      }
      throw error;
    }
    const requestStartedAt = now();
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAVAILABLE",
        `Could not reach the Keycloak admin API at ${url}: ` +
          (error instanceof Error ? error.message : String(error)),
        undefined,
        { operation, durationMs: Math.max(0, now() - requestStartedAt) },
      );
    }

    const body = await readJson(response);
    if (response.ok) return { status: response.status, body };

    if (response.status === 401 || response.status === 403) {
      tokens.invalidate();
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAUTHORIZED",
        `The Keycloak admin API refused "${config.clientId}" ${what}: ` +
          `${describeError(body, response.statusText)}. The service account must hold ` +
          "realm-management manage-realm.",
        response.status,
        { operation, durationMs: Math.max(0, now() - requestStartedAt) },
      );
    }
    if (response.status === 404) {
      if (notFoundIsAnswer) return { status: response.status, body };
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND",
        "The Keycloak organization this tenant is linked to no longer exists.",
        response.status,
        { operation, durationMs: Math.max(0, now() - requestStartedAt) },
      );
    }
    if (response.status === 400 || response.status === 409) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_REJECTED",
        `The Keycloak admin API rejected the request while ${what}: ` +
          describeError(body, response.statusText),
        response.status,
        { operation, durationMs: Math.max(0, now() - requestStartedAt) },
      );
    }
    // Includes the realm's own 500 "Failed to send invite email" — a
    // deployment fault (SMTP is not configured on this realm), not something
    // the caller's input can fix, so it is classified the same way an
    // unreachable Keycloak would be, with the realm's own message carried
    // through rather than redacted.
    throw new KeycloakAdminError(
      "KEYCLOAK_ADMIN_UNAVAILABLE",
      `The Keycloak admin API answered ${response.status} while ${what}: ` +
        describeError(body, response.statusText),
      response.status,
      { operation, durationMs: Math.max(0, now() - requestStartedAt) },
    );
  }

  /**
   * One listed row, minus `inviteLink`. Every optional field is `string | null`
   * / `number | null` rather than an empty string or a zero, so "Keycloak did
   * not report a surname" stays distinguishable from "the surname is blank".
   */
  function toInvitation(row: unknown): KeycloakOrganizationInvitation | null {
    const record = (row ?? {}) as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    // A row without an id cannot be cancelled and cannot be referred to; it is
    // dropped rather than carried as an unusable handle.
    if (id.length === 0) return null;
    return {
      id,
      email: typeof record.email === "string" ? record.email : "",
      firstName: optionalString(record.firstName),
      lastName: optionalString(record.lastName),
      status: optionalString(record.status),
      sentDate: optionalNumber(record.sentDate),
      expiresAt: optionalNumber(record.expiresAt),
    };
  }

  async function listInvitations(
    organizationId: string,
  ): Promise<KeycloakOrganizationInvitation[]> {
    const invitations: KeycloakOrganizationInvitation[] = [];
    for (let first = 0; first < 10000; first += 100) {
      const { body } = await request(
        `${invitationsUrl(organizationId)}?first=${first}&max=100`,
        { method: "GET" },
        "listing the pending invitations",
        "list_invitations",
      );
      if (!Array.isArray(body)) {
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_UNAVAILABLE",
          "Invalid invitation list response.",
        );
      }
      for (const row of body) {
        const invitation = toInvitation(row);
        if (!invitation || !invitation.email) {
          throw new KeycloakAdminError(
            "KEYCLOAK_ADMIN_UNAVAILABLE",
            "Invalid invitation response.",
          );
        }
        invitations.push(invitation);
      }
      if (body.length < 100) return invitations;
    }
    throw new KeycloakAdminError(
      "KEYCLOAK_ADMIN_UNAVAILABLE",
      "Invitation listing exceeds the supported bound; no partial list is returned.",
    );
  }

  return {
    async hasInvitationMailConfiguration() {
      const { body } = await request(realmBase, { method: "GET" }, "checking invitation mail configuration", "check_invitation_smtp");
      const smtp = (body as { smtpServer?: Record<string, string> })?.smtpServer;
      return Boolean(smtp?.host?.trim() && smtp?.from?.trim());
    },
    async organizationAdministrators(organizationId, clientId, role) {
      const { body: clients } = await request(`${realmBase}/clients?clientId=${encodeURIComponent(clientId)}`, { method: "GET" }, "resolving the role client", "resolve_role_client");
      if (!Array.isArray(clients) || clients.length !== 1 || clients[0]?.clientId !== clientId || typeof clients[0]?.id !== "string") {
        throw new KeycloakAdminError("KEYCLOAK_ADMIN_REJECTED", "The organization role client is missing or ambiguous.");
      }
      const result: { email: string | null }[] = [];
      for (let first = 0; ; first += 100) {
        const { body: members } = await request(`${adminBase}/${encodeURIComponent(organizationId)}/members?first=${first}&max=100`, { method: "GET" }, "checking organization administrators", "list_organization_members");
        if (!Array.isArray(members)) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid organization members response.");
        for (const member of members) {
          if (typeof member.id !== "string") throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid organization member.");
          const { body: roles } = await request(`${realmBase}/users/${encodeURIComponent(member.id)}/role-mappings/clients/${encodeURIComponent(clients[0].id)}/composite`, { method: "GET" }, "checking organization administrator roles", "list_member_roles");
          if (!Array.isArray(roles)) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid member roles response.");
          if (roles.some(r => r.name === role)) result.push({ email: optionalString(member.email) });
        }
        if (members.length < 100) return result;
      }
    },
    async inviteUser(organizationId, input) {
      const body = new URLSearchParams({ email: input.email });
      if (input.firstName) body.set("firstName", input.firstName);
      if (input.lastName) body.set("lastName", input.lastName);

      await request(
        `${adminBase}/${encodeURIComponent(organizationId)}/members/invite-user`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        },
        "inviting a member",
        "invite_member",
      );
    },

    async resendInvitation(organizationId, invitationId) {
      await request(
        `${invitationsUrl(organizationId)}/${encodeURIComponent(invitationId)}/resend`,
        { method: "POST" },
        "resending an invitation",
        "resend_invitation",
      );
    },

    listInvitations,

    async deleteInvitation(organizationId, invitationId) {
      const { status } = await request(
        `${invitationsUrl(organizationId)}/${encodeURIComponent(invitationId)}`,
        { method: "DELETE" },
        "cancelling an invitation",
        "delete_invitation",
        true,
      );
      return status !== 404;
    },

    async findPendingInvitationByEmail(organizationId, email) {
      const wanted = normalizeEmail(email);
      if (wanted.length === 0) return null;
      // No status filter: on 26.5.3 this resource only ever listed PENDING
      // rows, and filtering on a string whose other values have never been
      // observed would silently hide an invitation the moment Keycloak adds one.
      const found = (await listInvitations(organizationId)).find(
        (invitation) => normalizeEmail(invitation.email) === wanted,
      );
      return found ?? null;
    },
  };
}
