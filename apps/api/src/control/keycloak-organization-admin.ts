// SPDX-License-Identifier: BUSL-1.1
// Protocol notes and public contracts: ./keycloak-organization-admin-types.ts
import {
  createServiceAccountTokenProvider,
  createKeycloakFetch,
  describeError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig,
} from "./keycloak-service-account.js";

import { type KeycloakAdminErrorCode, type KeycloakAdminOperation, KeycloakAdminError, type KeycloakOrganizationState, ORGANIZATION_ATTRIBUTE_KEYS, type KeycloakOrganizationSnapshot, type ListOrganizationsResult, type OrganizationIdentityProvider, type KeycloakOrganizationAdminClient, type KeycloakOrganizationAdminOptions } from "./keycloak-organization-admin-types.js";
export * from "./keycloak-organization-admin-types.js";

export function createKeycloakOrganizationAdminClient(
  config: KeycloakServiceAccountConfig,
  options: KeycloakOrganizationAdminOptions = {},
): KeycloakOrganizationAdminClient {
  const doFetch = createKeycloakFetch(config, options.fetch ?? globalThis.fetch);
  const now = options.now ?? (() => Date.now());
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

  /**
   * The organization id is percent-encoded even though #294 fixed the SPI's
   * `create` binding and Keycloak now generates a uuid for it. An id read back
   * from the registry is whatever was stamped there when the row was
   * provisioned, so a deployment that provisioned tenants before that fix still
   * holds name-shaped ids, and encoding is what keeps those addressable.
   */
  function organizationUrl(organizationId: string): string {
    return `${adminBase}/${encodeURIComponent(organizationId)}`;
  }

  async function request(
    url: string,
    init: RequestInit,
    operation: KeycloakAdminOperation,
    contentType: string = "application/json",
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
          ...(init.body === undefined ? {} : { "content-type": contentType }),
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
      // Same reasoning as the SPI client: drop the cached token so a rotated
      // credential is picked up without a restart, and do NOT present this as
      // the operator's 403 — the operator is authorized, the platform's own
      // service account is not.
      tokens.invalidate();
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_UNAUTHORIZED",
        `The Keycloak admin API refused "${config.clientId}": ` +
          `${describeError(body, response.statusText)}. The service account must hold ` +
          "realm-management manage-realm.",
        response.status,
        { operation, durationMs: Math.max(0, now() - requestStartedAt) },
      );
    }
    if (response.status === 404) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND",
        "The Keycloak organization this tenant is linked to no longer exists. " +
          "Replay the tenant's provisioning create to recreate and relink it.",
        response.status,
        { operation, durationMs: Math.max(0, now() - requestStartedAt) },
      );
    }
    if (response.status === 400) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_REJECTED",
        describeError(body, "The Keycloak admin API rejected the request."),
        response.status,
        { operation, durationMs: Math.max(0, now() - requestStartedAt) },
      );
    }
    throw new KeycloakAdminError(
      "KEYCLOAK_ADMIN_UNAVAILABLE",
      `The Keycloak admin API answered ${response.status}: ` +
        describeError(body, response.statusText),
      response.status,
      { operation, durationMs: Math.max(0, now() - requestStartedAt) },
    );
  }

  function toState(body: unknown, fallbackId: string): KeycloakOrganizationState {
    const record = (body ?? {}) as Record<string, unknown>;
    return {
      id: typeof record.id === "string" ? record.id : fallbackId,
      name: typeof record.name === "string" ? record.name : "",
      alias: typeof record.alias === "string" ? record.alias : "",
      // Absent means enabled in Keycloak's representation, so an absent flag
      // must not read as "suspended" — that would report every organization
      // from an older representation as down.
      enabled: record.enabled !== false,
    };
  }

  /**
   * Keycloak stores every organization attribute as a LIST of strings, because
   * the underlying model is multi-valued. The four this reads are written by
   * the SPI as `List.of(oneValue)`, so the first element is the value and an
   * empty or absent list is "unset". A list with more than one element would
   * mean something other than the SPI wrote it, and taking the first is the
   * same choice the SPI's own `first(...)` helper makes.
   */
  function attribute(body: unknown, key: string): string | null {
    const attributes = (body as { attributes?: unknown } | null)?.attributes;
    if (!attributes || typeof attributes !== "object") return null;
    const value = (attributes as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === "string" && first.length > 0 ? first : null;
    }
    // Not a shape Keycloak produces, but a single string is the obvious
    // degenerate case and reading it costs one line.
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function toSnapshot(body: unknown, fallbackId: string): KeycloakOrganizationSnapshot {
    return {
      ...toState(body, fallbackId),
      organizationLevel: attribute(body, ORGANIZATION_ATTRIBUTE_KEYS.level),
      organizationPath: attribute(body, ORGANIZATION_ATTRIBUTE_KEYS.path),
      parentOrganizationId: attribute(
        body,
        ORGANIZATION_ATTRIBUTE_KEYS.parentOrganizationId,
      ),
      rootOrganizationId: attribute(body, ORGANIZATION_ATTRIBUTE_KEYS.rootOrganizationId),
    };
  }

  return {
    async getOrganization(organizationId) {
      const { body } = await request(organizationUrl(organizationId), { method: "GET" }, "get_organization");
      return toState(body, organizationId);
    },

    async setOrganizationEnabled(organizationId, enabled) {
      const url = organizationUrl(organizationId);
      const { body } = await request(url, { method: "GET" }, "get_organization_for_update");
      const current = toState(body, organizationId);
      if (current.enabled === enabled) {
        return { organization: current, changed: false };
      }

      // The FULL representation back, with one field changed. See the header:
      // the hierarchy attributes ride along untouched rather than trusting
      // Keycloak to merge a partial body.
      const representation = { ...((body ?? {}) as Record<string, unknown>), enabled };
      await request(url, { method: "PUT", body: JSON.stringify(representation) }, "update_organization");
      return { organization: { ...current, enabled }, changed: true };
    },

    async listOrganizations(limit) {
      // limit + 1, so "there are more" is answered by the same call rather than
      // by a second count — the same trick the registry reads use.
      const search = new URLSearchParams({
        briefRepresentation: "false",
        first: "0",
        max: String(limit + 1),
      });
      const { body } = await request(`${adminBase}?${search.toString()}`, {
        method: "GET",
      }, "list_organizations");
      const rows = Array.isArray(body) ? body : [];
      const organizations = rows
        .slice(0, limit)
        .map((row) => toSnapshot(row, ""))
        // An organization with no id is not addressable and cannot be compared
        // against anything; dropping it is safer than carrying an empty key that
        // would collide with every other malformed row in the map built from this.
        .filter((organization) => organization.id.length > 0);
      return { organizations, truncated: rows.length > limit };
    },

    async linkIdentityProvider(organizationId, alias) {
      // The native endpoint's body is the alias as a JSON string (i.e. the
      // literal bytes `"alias"`), Content-Type application/json — verified
      // against a running Keycloak 26.5.3: a bare unquoted string with
      // text/plain is rejected with 415, and a JSON-quoted string succeeds
      // with 204.
      await request(`${organizationUrl(organizationId)}/identity-providers`, {
        method: "POST",
        body: JSON.stringify(alias),
      }, "link_identity_provider");
    },

    async listIdentityProviders(organizationId) {
      const { body } = await request(
        `${organizationUrl(organizationId)}/identity-providers`,
        { method: "GET" },
        "list_identity_providers",
      );
      const rows = Array.isArray(body) ? body : [];
      return rows
        .map((row) => {
          const record = (row ?? {}) as Record<string, unknown>;
          return typeof record.alias === "string"
            ? {
                alias: record.alias,
                providerId: typeof record.providerId === "string" ? record.providerId : "",
                enabled: record.enabled !== false,
              }
            : null;
        })
        .filter((idp): idp is OrganizationIdentityProvider => idp !== null);
    },

    async unlinkIdentityProvider(organizationId, alias) {
      try {
        await request(
          `${organizationUrl(organizationId)}/identity-providers/${encodeURIComponent(alias)}`,
          { method: "DELETE" },
          "unlink_identity_provider",
        );
      } catch (error) {
        // Already unlinked (or never linked): idempotent, not an error. A
        // missing ORGANIZATION is a real error and still throws.
        if (
          error instanceof KeycloakAdminError &&
          error.code === "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND" &&
          error.status === 404
        ) {
          return;
        }
        throw error;
      }
    },
  };
}
