// SPDX-License-Identifier: BUSL-1.1
/**
 * Granting a real Keycloak client role onto a signed-in PERSON's user —
 * what `set_member_role` (mcp/identity-link-tools.ts) does once an
 * organization administrator decides a JIT-created identity
 * (`platform.identity_relations.needs_role_assignment`, see
 * auth/identity-link.ts and db/migrations/identity-link.ts) is an
 * `org_admin` or `org_employee`.
 *
 * Same admin-client shape as keycloak-organization-admin.ts and
 * organization-scopes.ts: authenticate once as `openshapeforge-auth-api`
 * (`control/keycloak-service-account.ts`) against the tenant realm, share its
 * token cache when the caller has one already.
 *
 * WHY `manage-users`, AND WHY THAT IS A NEW GRANT
 * ------------------------------------------------
 * `POST /users/{id}/role-mappings/clients/{clientUuid}` is USER role-mapping,
 * a distinct admin-permission bucket from `manage-realm` (realm settings, the
 * Organizations endpoints, the identity-configuration SPI) and `manage-clients`
 * (client + client-scope configuration, `organization-scopes.ts`). Neither
 * covers it — every `/role-mappings` call for a plain (non-service-account)
 * user answers 403 with either alone, verified on 26.5.3 the same way the
 * `manage-clients` gap was. `authoring/hubble-demo/authorization.yaml` grants
 * `manage-users` to `openshapeforge-auth-api` for exactly this.
 *
 * WHY NOT REUSE `auth/api-key/keycloak-admin.ts`
 * -----------------------------------------------
 * That module already has a `grantClientRoles` method with the identical
 * shape, but it authenticates as `openshapeforge-apikey-provisioner` — a
 * DIFFERENT service account, scoped to minting and role-mapping THIRD-PARTY
 * API key clients. Reusing it here would mean this runtime surface (acting on
 * an administrator's own request) and that provisioning surface (acting on a
 * customer's API key request) share a credential whose compromise blast radius
 * is deliberately kept separate — the same reasoning
 * `authorization.yaml`'s comment on `openshapeforge-auth-api` gives for not
 * putting API-key provisioning's grants on IT. `openshapeforge-auth-api` is
 * already the identity-configuration credential this runtime authenticates
 * as for organization-scoped fixed operations, and a role grant that
 * originates from a Hubble MCP tool an org_admin calls is exactly that.
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

export type MemberRoleAdminOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Shared with the other control-plane admin clients so one token serves all. */
  tokens?: ServiceAccountTokenProvider;
};

export type MemberRoleAdminClient = {
  /**
   * Grant `roleNames` (must already exist on `clientId`) onto the user whose
   * Keycloak id is `userId` (the token's `sub`, which for an ordinary user IS
   * the Keycloak internal user id). Additive: existing role mappings on the
   * user are left alone. Roles that do not exist on the client are a caller
   * error (`KEYCLOAK_ADMIN_REJECTED`), not silently skipped — granting fewer
   * roles than named would leave `set_member_role` reporting success for a
   * grant that did not fully happen.
   */
  grantClientRoles(userId: string, clientId: string, roleNames: readonly string[]): Promise<void>;
};

export function createMemberRoleAdminClient(
  config: KeycloakServiceAccountConfig,
  options: MemberRoleAdminOptions = {},
): MemberRoleAdminClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const adminBase = `${config.baseUrl}/admin/realms/${encodeURIComponent(config.tenantRealm)}`;

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

  async function request(
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${adminBase}${path}`;
    const token = await tokens.get();
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAVAILABLE",
        `Could not reach the Keycloak admin API at ${url}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const body = await readJson(response);
    if (response.ok) return { status: response.status, body };

    if (response.status === 401 || response.status === 403) {
      tokens.invalidate();
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAUTHORIZED",
        `The Keycloak admin API refused "${config.clientId}" on ${init.method ?? "GET"} ${path}: ` +
          `${describeError(body, response.statusText)}. User role mappings need ` +
          "realm-management manage-users, in addition to manage-realm and manage-clients.",
        response.status,
      );
    }
    if (response.status === 400 || response.status === 404 || response.status === 409) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_REJECTED",
        `The Keycloak admin API rejected ${init.method ?? "GET"} ${path}: ` +
          describeError(body, response.statusText),
        response.status,
      );
    }
    throw new KeycloakAdminError(
      "KEYCLOAK_ADMIN_UNAVAILABLE",
      `The Keycloak admin API answered ${response.status} on ${path}: ` +
        describeError(body, response.statusText),
      response.status,
    );
  }

  return {
    async grantClientRoles(userId, clientId, roleNames) {
      if (roleNames.length === 0) return;

      const { body: clients } = await request(
        `/clients?clientId=${encodeURIComponent(clientId)}`,
        { method: "GET" },
      );
      const clientUuid = (Array.isArray(clients) ? clients : [])
        .map((row) => (row as Record<string, unknown>).id)
        .find((id): id is string => typeof id === "string");
      if (!clientUuid) {
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_REJECTED",
          `Client "${clientId}" does not exist in this realm.`,
        );
      }

      const { body: available } = await request(
        `/clients/${encodeURIComponent(clientUuid)}/roles`,
        { method: "GET" },
      );
      const byName = new Map(
        (Array.isArray(available) ? available : [])
          .map((row) => row as Record<string, unknown>)
          .filter(
            (row): row is { id: string; name: string } =>
              typeof row.id === "string" && typeof row.name === "string",
          )
          .map((row) => [row.name, row]),
      );

      const missing = roleNames.filter((name) => !byName.has(name));
      if (missing.length > 0) {
        throw new KeycloakAdminError(
          "KEYCLOAK_ADMIN_REJECTED",
          `Roles do not exist on client "${clientId}": ${missing.sort().join(", ")}.`,
        );
      }

      await request(
        `/users/${encodeURIComponent(userId)}/role-mappings/clients/${encodeURIComponent(clientUuid)}`,
        {
          method: "POST",
          body: JSON.stringify(roleNames.map((name) => byName.get(name))),
        },
      );
    },
  };
}
