// SPDX-License-Identifier: BUSL-1.1
// Protocol notes and public contracts: ./keycloak-organization-members-types.ts
import {
  createServiceAccountTokenProvider,
  createKeycloakFetch,
  describeError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig,
} from "./keycloak-service-account.js";
import {
  KeycloakAdminError,
  type KeycloakAdminOperation,
} from "./keycloak-organization-admin.js";

import { type InviteOrganizationMemberInput, type KeycloakOrganizationInvitation, type KeycloakOrganizationMembersClient, type KeycloakTenantMemberAdminClient, type KeycloakOrganizationMember, type KeycloakMemberCredential, type KeycloakOrganizationMembersOptions, type OrganizationBootstrapReads } from "./keycloak-organization-members-types.js";
export * from "./keycloak-organization-members-types.js";

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
): KeycloakTenantMemberAdminClient & OrganizationBootstrapReads {
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

  function toMember(row: unknown): KeycloakOrganizationMember | null {
    const value = (row ?? {}) as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id) return null;
    return {
      memberId: value.id,
      username: optionalString(value.username),
      email: optionalString(value.email),
      firstName: optionalString(value.firstName),
      lastName: optionalString(value.lastName),
      enabled: value.enabled !== false,
      emailVerified: value.emailVerified === true,
    };
  }

  return {
    async hasMemberByEmail(organizationId, email) {
      const wanted = normalizeEmail(email);
      if (wanted.length === 0) return false;
      for (let first = 0; first < 10000; first += 100) {
        const { body } = await request(
          `${adminBase}/${encodeURIComponent(organizationId)}/members?first=${first}&max=100`,
          { method: "GET" },
          "checking organization membership",
          "list_organization_members",
        );
        if (!Array.isArray(body)) {
          throw new KeycloakAdminError(
            "KEYCLOAK_ADMIN_UNAVAILABLE",
            "Invalid organization member response.",
          );
        }
        if (body.some((row) =>
          typeof row?.email === "string" && normalizeEmail(row.email) === wanted
        )) return true;
        if (body.length < 100) return false;
      }
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAVAILABLE",
        "Organization member listing exceeds the supported bound.",
      );
    },
    async listMembers(organizationId) {
      const members: KeycloakOrganizationMember[] = [];
      for (let first = 0; first < 10000; first += 100) {
        const { body } = await request(`${adminBase}/${encodeURIComponent(organizationId)}/members?first=${first}&max=100`, { method: "GET" }, "listing organization members", "list_organization_members");
        if (!Array.isArray(body)) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid organization members response.");
        for (const row of body) {
          const member = toMember(row);
          if (!member) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid organization member response.");
          members.push(member);
        }
        if (body.length < 100) return members;
      }
      throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Organization member listing exceeds the supported bound.");
    },

    async getMember(organizationId, userId) {
      return (await this.listMembers(organizationId)).find((member) => member.memberId === userId) ?? null;
    },

    async listFederatedIdentities(organizationId, userId) {
      // The downstream endpoint is realm-global. Prove this organization's
      // membership first and never accept a caller's arbitrary realm user ID.
      if (!(await this.getMember(organizationId, userId))) {
        throw new KeycloakAdminError("KEYCLOAK_ADMIN_REJECTED", "Account is not a member of this organization.", 404);
      }
      const { body } = await request(
        `${realmBase}/users/${encodeURIComponent(userId)}/federated-identity`,
        { method: "GET" }, "reading linked login providers", "list_member_federated_identities",
      );
      if (!Array.isArray(body) || body.length > 100 || body.some(row =>
        !row || typeof row !== "object" || typeof row.identityProvider !== "string" ||
        !row.identityProvider.trim() || row.identityProvider.length > 255)) {
        throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid linked login provider response.");
      }
      return [...new Set(body.map(row => row.identityProvider as string))].sort().map(alias => ({ alias }));
    },

    async listCredentials(userId) {
      const { body } = await request(`${realmBase}/users/${encodeURIComponent(userId)}/credentials`, { method: "GET" }, "listing member credentials", "list_member_credentials");
      if (!Array.isArray(body)) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid credential list response.");
      return body.flatMap((row): KeycloakMemberCredential[] => {
        if (typeof row?.id !== "string" || typeof row?.type !== "string") return [];
        return [{ credentialId: row.id, type: row.type, label: optionalString(row.userLabel), createdAt: optionalNumber(row.createdDate) }];
      });
    },

    async deleteCredential(userId, credentialId) {
      const { status } = await request(`${realmBase}/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`, { method: "DELETE" }, "deleting a member credential", "delete_member_credential", true);
      return status !== 404;
    },

    async removeMember(organizationId, userId) {
      const { status } = await request(`${adminBase}/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }, "removing an organization member", "remove_organization_member", true);
      return status !== 404;
    },

    async sendPasskeyRecovery(userId) {
      await request(`${realmBase}/users/${encodeURIComponent(userId)}/execute-actions-email?lifespan=900`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(["webauthn-register-passwordless"]),
      }, "sending passkey recovery", "send_passkey_recovery");
    },
    async sendPasswordRecovery(userId) {
      await request(`${realmBase}/users/${encodeURIComponent(userId)}/execute-actions-email?lifespan=900`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(["UPDATE_PASSWORD"]),
      }, "sending password recovery", "send_password_recovery");
    },
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

    async inviteExistingMember(organizationId, email) {
      const wanted = normalizeEmail(email);
      if (wanted.length === 0) return false;
      let id: string | undefined;
      for (let first = 0; first < 10000 && !id; first += 100) {
        const { body } = await request(
          `${adminBase}/${encodeURIComponent(organizationId)}/members?first=${first}&max=100`,
          { method: "GET" }, "checking organization membership", "list_organization_members",
        );
        if (!Array.isArray(body)) throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "Invalid organization member response.");
        id = body.find((row) => typeof row?.email === "string" && normalizeEmail(row.email) === wanted && typeof row?.id === "string")?.id;
        if (body.length < 100) break;
      }
      if (!id) return false;
      await request(
        `${adminBase}/${encodeURIComponent(organizationId)}/members/invite-existing-user`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id }).toString() },
        "inviting an existing member", "invite_existing_member",
      );
      return true;
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
