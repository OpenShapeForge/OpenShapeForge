// SPDX-License-Identifier: BUSL-1.1
/**
 * The realm mutations provisioning needs, over Keycloak's Admin REST API.
 *
 * Deliberately NOT the OpenShapeForge SPI (`packages/keycloak-spi`). That
 * extension exists for operations the Admin API cannot express —
 * organization-scoped groups, roles and permission grants. Creating a
 * confidential client, reading its secret, and mapping roles onto its service
 * account are all first-class Admin API operations, so reaching for the SPI
 * would mean maintaining Java to re-expose endpoints Keycloak already ships.
 *
 * Authenticates as the `openshapeforge-apikey-provisioner` service account,
 * which the generated realm grants `realm-management: manage-clients` and
 * `manage-users` — and nothing else. Note that `manage-realm` (which
 * `openshapeforge-auth-api` holds) does NOT cover either: Keycloak gates realm
 * SETTINGS separately from client and user administration, which is why this
 * needs its own client rather than reusing that one.
 */

export type KeycloakAdminConfig = {
  /** Base URL, e.g. http://localhost:8181 */
  baseUrl: string;
  realm: string;
  /** The service account this module acts as. */
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
};

export class KeycloakAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KeycloakAdminError";
  }
}

/**
 * Projects the service account's `tid` USER ATTRIBUTE into the `tid` CLAIM.
 *
 * Without this the token verifies, carries the right roles and the right
 * audience — and resolves to a null tenant, because nothing tells Keycloak to
 * emit the attribute. Every request then fails at the session layer with no
 * hint as to why. The generated realm puts the identical mapper on the gateway
 * client (`gatewayProtocolMappers` in the compiler's Keycloak generator);
 * clients minted at runtime need their own copy.
 */
const TENANT_CLAIM_MAPPER = {
  name: "tid-mapper",
  protocol: "openid-connect",
  protocolMapper: "oidc-usermodel-attribute-mapper",
  consentRequired: false,
  config: {
    "user.attribute": "tid",
    "claim.name": "tid",
    "jsonType.label": "String",
    "id.token.claim": "true",
    "access.token.claim": "true",
    "userinfo.token.claim": "true",
    multivalued: "false",
    "aggregate.attrs": "false",
  },
};

export type ProvisionedClient = {
  /** Keycloak's internal UUID for the client. */
  internalId: string;
  /** The clientId string callers authenticate with. */
  clientId: string;
  clientSecret: string;
  /** The service-account user backing the client. */
  serviceAccountUserId: string;
};

export class KeycloakAdmin {
  private token: { value: string; expiresAtMs: number } | undefined;

  constructor(private readonly config: KeycloakAdminConfig) {}

  private get doFetch(): typeof fetch {
    return this.config.fetch ?? fetch;
  }

  private get realmUrl(): string {
    return `${this.config.baseUrl}/admin/realms/${this.config.realm}`;
  }

  /** Admin tokens are short-lived; cache with the same safety margin as the exchange path. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now) return this.token.value;

    const response = await this.doFetch(
      `${this.config.baseUrl}/realms/${this.config.realm}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }).toString(),
      },
    );
    if (!response.ok) {
      throw new KeycloakAdminError(
        "Could not obtain a Keycloak admin token; API key provisioning is unavailable.",
        response.status,
      );
    }
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new KeycloakAdminError("Keycloak returned no access token for the admin client.");
    }
    this.token = {
      value: payload.access_token,
      expiresAtMs: now + Math.max(5_000, (payload.expires_in ?? 60) * 1000 - 30_000),
    };
    return payload.access_token;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const token = await this.accessToken();
    return this.doFetch(`${this.realmUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    if (!response.ok) {
      throw new KeycloakAdminError(
        `Keycloak admin ${method} ${path} failed with ${response.status}.`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Create a confidential, service-account-only client.
   *
   * Shaped to be inert as anything but a machine identity: no browser flows, no
   * direct-access grants (so the client's secret cannot be traded for a USER's
   * token), and no redirect URIs to mis-configure.
   */
  async createServiceAccountClient(
    clientId: string,
    displayName: string,
  ): Promise<ProvisionedClient> {
    const response = await this.request("POST", "/clients", {
      clientId,
      name: displayName,
      protocol: "openid-connect",
      publicClient: false,
      bearerOnly: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      enabled: true,
      protocolMappers: [TENANT_CLAIM_MAPPER],
    });

    if (response.status === 409) {
      throw new KeycloakAdminError(`Keycloak client "${clientId}" already exists.`, 409);
    }
    if (!response.ok) {
      throw new KeycloakAdminError(
        `Creating Keycloak client "${clientId}" failed with ${response.status}.`,
        response.status,
      );
    }

    const clients = await this.json<Array<{ id: string }>>(
      "GET",
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    );
    const internalId = clients[0]?.id;
    if (!internalId) {
      throw new KeycloakAdminError(`Created client "${clientId}" could not be read back.`);
    }

    const secret = await this.json<{ value?: string }>(
      "GET",
      `/clients/${internalId}/client-secret`,
    );
    if (!secret.value) {
      throw new KeycloakAdminError(`Client "${clientId}" has no secret.`);
    }

    const serviceAccount = await this.json<{ id?: string }>(
      "GET",
      `/clients/${internalId}/service-account-user`,
    );
    if (!serviceAccount.id) {
      throw new KeycloakAdminError(`Client "${clientId}" has no service account user.`);
    }

    return {
      internalId,
      clientId,
      clientSecret: secret.value,
      serviceAccountUserId: serviceAccount.id,
    };
  }

  /**
   * Stamp the tenant onto the service-account user.
   *
   * This is what makes the exchanged token carry a `tid` claim, and therefore
   * what makes an API key tenant-scoped at all. Without it the token verifies
   * but resolves to a null tenant and every request is refused by the session
   * layer — a confusing failure, so provisioning treats this as required.
   */
  async setServiceAccountTenant(userId: string, tenantId: string): Promise<void> {
    const user = await this.json<{ attributes?: Record<string, unknown> }>(
      "GET",
      `/users/${userId}`,
    );
    const response = await this.request("PUT", `/users/${userId}`, {
      attributes: { ...(user.attributes ?? {}), tid: [tenantId] },
    });
    if (!response.ok) {
      throw new KeycloakAdminError(
        `Setting tid on service account ${userId} failed with ${response.status}.`,
        response.status,
      );
    }
  }

  /** Map client roles onto the service-account user. Roles must already exist on `roleClientId`. */
  async grantClientRoles(
    serviceAccountUserId: string,
    roleClientId: string,
    roleNames: readonly string[],
  ): Promise<void> {
    if (roleNames.length === 0) return;

    const clients = await this.json<Array<{ id: string }>>(
      "GET",
      `/clients?clientId=${encodeURIComponent(roleClientId)}`,
    );
    const roleClientInternalId = clients[0]?.id;
    if (!roleClientInternalId) {
      throw new KeycloakAdminError(`Role client "${roleClientId}" does not exist.`);
    }

    const available = await this.json<Array<{ id: string; name: string }>>(
      "GET",
      `/clients/${roleClientInternalId}/roles`,
    );
    const byName = new Map(available.map((role) => [role.name, role]));

    // A requested role that does not exist in the realm is a caller error, not
    // something to silently drop: dropping it would provision a key with fewer
    // roles than the customer was shown, and the difference would surface later
    // as an unexplained 403.
    const missing = roleNames.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      throw new KeycloakAdminError(
        `Roles do not exist on client "${roleClientId}": ${missing.sort().join(", ")}.`,
      );
    }

    const response = await this.request(
      "POST",
      `/users/${serviceAccountUserId}/role-mappings/clients/${roleClientInternalId}`,
      roleNames.map((name) => byName.get(name)),
    );
    if (!response.ok) {
      throw new KeycloakAdminError(
        `Granting roles to ${serviceAccountUserId} failed with ${response.status}.`,
        response.status,
      );
    }
  }

  /** Remove a client. Used by the reconciler to sweep a half-provisioned integration. */
  async deleteClient(clientId: string): Promise<void> {
    const clients = await this.json<Array<{ id: string }>>(
      "GET",
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    );
    const internalId = clients[0]?.id;
    if (!internalId) return;

    const response = await this.request("DELETE", `/clients/${internalId}`);
    if (!response.ok && response.status !== 404) {
      throw new KeycloakAdminError(
        `Deleting Keycloak client "${clientId}" failed with ${response.status}.`,
        response.status,
      );
    }
  }

  /** Whether a client still exists. The reconciler's "was the realm reset?" probe. */
  async clientExists(clientId: string): Promise<boolean> {
    const clients = await this.json<Array<{ id: string }>>(
      "GET",
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    );
    return clients.length > 0;
  }
}
