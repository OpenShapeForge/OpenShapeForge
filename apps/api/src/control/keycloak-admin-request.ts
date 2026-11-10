// SPDX-License-Identifier: BUSL-1.1
import { createKeycloakFetch, createServiceAccountTokenProvider, describeError, readJson, REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig, type ServiceAccountTokenProvider } from "./keycloak-service-account.js";
import { KeycloakAdminError, type KeycloakAdminOperation } from "./keycloak-organization-admin-types.js";

export type KeycloakAdminRequestOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  tokens?: ServiceAccountTokenProvider;
};

type ResponsePolicy = {
  what?: string;
  contentType?: string;
  notFoundIsAnswer?: boolean;
  notFoundMessage?: string;
  rejectedStatuses?: readonly number[];
};

/** Transport and service-account failures have one meaning across admin clients.
 * Resource-specific status meanings stay explicit at their call boundary. */
export function createKeycloakAdminRequest(config: KeycloakServiceAccountConfig, options: KeycloakAdminRequestOptions) {
  const doFetch = createKeycloakFetch(config, options.fetch ?? globalThis.fetch);
  const now = options.now ?? Date.now;
  const tokens = options.tokens ?? createServiceAccountTokenProvider(config, {
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}),
    unauthorized: (message, status) => new KeycloakAdminError("KEYCLOAK_ADMIN_UNAUTHORIZED", message, status),
    unavailable: (message, status) => new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", message, status),
  });
  return async (url: string, init: RequestInit, operation: KeycloakAdminOperation, policy: ResponsePolicy = {}): Promise<{ status: number; body: unknown }> => {
    const tokenStartedAt = now();
    let token: string;
    try { token = await tokens.get(); }
    catch (error) {
      if (error instanceof KeycloakAdminError && error.operation === undefined) {
        throw new KeycloakAdminError(error.code, error.message, error.status, {
          operation: "service_account_token", durationMs: Math.max(0, now() - tokenStartedAt),
        });
      }
      throw error;
    }
    const requestStartedAt = now();
    const metadata = () => ({ operation, durationMs: Math.max(0, now() - requestStartedAt) });
    let response: Response;
    try {
      response = await doFetch(url, { ...init, headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined && policy.contentType ? { "content-type": policy.contentType } : {}),
        ...init.headers,
      }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", `Could not reach the Keycloak admin API at ${url}: `
        + (error instanceof Error ? error.message : String(error)), undefined, metadata());
    }
    const body = await readJson(response);
    if (response.ok || (response.status === 404 && policy.notFoundIsAnswer)) return { status: response.status, body };
    if (response.status === 401 || response.status === 403) {
      tokens.invalidate();
      throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAUTHORIZED", `The Keycloak admin API refused "${config.clientId}"`
        + (policy.what ? ` ${policy.what}` : "") + `: ${describeError(body, response.statusText)}. The service account must hold realm-management manage-realm.`, response.status, metadata());
    }
    if (response.status === 404) {
      throw new KeycloakAdminError("KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND", policy.notFoundMessage
        ?? "The Keycloak organization this tenant is linked to no longer exists.", response.status, metadata());
    }
    if ((policy.rejectedStatuses ?? [400]).includes(response.status)) {
      throw new KeycloakAdminError("KEYCLOAK_ADMIN_REJECTED", policy.what
        ? `The Keycloak admin API rejected the request while ${policy.what}: ${describeError(body, response.statusText)}`
        : describeError(body, "The Keycloak admin API rejected the request."), response.status, metadata());
    }
    throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", `The Keycloak admin API answered ${response.status}`
      + (policy.what ? ` while ${policy.what}` : "") + `: ${describeError(body, response.statusText)}`, response.status, metadata());
  };
}
