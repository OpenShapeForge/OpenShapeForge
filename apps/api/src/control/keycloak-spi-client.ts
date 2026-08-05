// SPDX-License-Identifier: BUSL-1.1
/**
 * Typed client for the OpenShapeForge identity-configuration SPI
 * (`packages/keycloak-spi/.../OpenShapeForgeResource.java`), mounted by Keycloak
 * at `/realms/{realm}/openshapeforge/*`.
 *
 * WHO CALLS IT, AND WHY IT CANNOT BE THE OPERATOR
 * ----------------------------------------------
 * The SPI is a RealmResourceProvider. `requireAdminBearer()` authenticates the
 * bearer against `session.getContext().getRealm()` — the realm in the URL — and
 * then requires the subject to hold realm-management `manage-realm`. A control
 * realm token is signed by a different realm and has no subject there, so it can
 * never authenticate, let alone authorize. Cross-realm is therefore structural,
 * not a design choice: the only principal that can reach the SPI is the
 * `openshapeforge-auth-api` service account of the TENANT realm, via
 * client_credentials. The operator's token is never forwarded here — this client
 * has no parameter that would let it be.
 *
 * WHAT THE RESPONSE CAN BE TRUSTED FOR
 * -----------------------------------
 * `id`, `organizationId`, `alias` and `name` only. The SPI builds its response
 * from the OrganizationModel immediately after `setAttributes(...)` in the same
 * transaction, and the attribute write is not visible to that read yet: on a
 * FIRST create the response's `organizationLevel`, `organizationPath` and
 * `parentOrganizationId` come back absent and `rootOrganizationId` falls back to
 * the organization's own id, even though the values persist correctly. Verified
 * against Keycloak 26.5.3. Nothing in this module reads them back, and callers
 * must not either — read the persisted state through the admin API if it is ever
 * needed (S7's drift report).
 *
 * IDEMPOTENCY
 * -----------
 * `POST /organizations` is upsert-shaped on the server: `getByAlias(alias)`
 * before `create`, and every attribute is rewritten on each call. Replaying an
 * identical request is a no-op that returns the same organization, which is what
 * lets the provisioning layer retry a partially-applied create.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Enabling and disabling an Organization. `OrganizationModel.enabled` is a
 * NATIVE Keycloak field with a native admin endpoint, so it belongs in
 * `keycloak-organization-admin.ts` rather than in a bespoke SPI route — this
 * SPI exists for what Keycloak has no concept of (the hierarchy attributes),
 * and every method added to it is another jar and image rebuild against a
 * runtime whose non-public SPIs have no cross-minor stability. Both modules
 * share one service-account token; see `keycloak-service-account.ts`.
 */
import {
  createServiceAccountTokenProvider,
  describeError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig,
  type ServiceAccountTokenProvider,
} from "./keycloak-service-account.js";

export type OrganizationLevel = "root" | "sub";

export type CreateOrganizationRequest = {
  /**
   * Realm-unique, URL-safe identifier. Keycloak's alias validator rejects `/`
   * and `:`; the provisioning layer joins slug chains with `--` for exactly that
   * reason (see `organization-naming.ts`).
   */
  alias: string;
  /**
   * Keycloak organization display name. ALSO realm-unique — Keycloak answers
   * `409 A organization with the same name already exists.` — so the
   * provisioning layer derives it rather than passing a human label through.
   */
  name: string;
  organizationLevel: OrganizationLevel;
  /** Root-to-leaf slug chain. Held unique per root organization by the SPI. */
  organizationPath: string;
  /** Required for `sub`, rejected for `root`. */
  parentOrganizationId?: string;
  /** Required for `sub`. The SPI validates that it agrees with the parent's root. */
  rootOrganizationId?: string;
};

export type KeycloakOrganization = {
  id: string;
  alias: string;
  name: string;
};

export type KeycloakSpiErrorCode =
  /** The SPI validated the request and refused it. Caller-actionable. */
  | "KEYCLOAK_SPI_REJECTED"
  /** organizationPath already used inside this root organization. */
  | "KEYCLOAK_SPI_CONFLICT"
  /**
   * The service account could not authenticate or lacks `manage-realm`. Not the
   * operator's fault and not fixable by retrying — a deployment fault.
   */
  | "KEYCLOAK_SPI_UNAUTHORIZED"
  /** Anything else: unreachable, 5xx, unparseable body. */
  | "KEYCLOAK_SPI_UNAVAILABLE";

export class KeycloakSpiError extends Error {
  readonly code: KeycloakSpiErrorCode;
  /** Upstream HTTP status, when there was a response at all. */
  readonly status: number | undefined;

  constructor(code: KeycloakSpiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "KeycloakSpiError";
    this.code = code;
    this.status = status;
  }
}

export type KeycloakSpiClient = {
  createOrganization(request: CreateOrganizationRequest): Promise<KeycloakOrganization>;
};

/**
 * Same shape as the shared service-account config, aliased so the SPI client's
 * own signature keeps reading in its own terms.
 */
export type KeycloakSpiClientConfig = KeycloakServiceAccountConfig;

export type KeycloakSpiClientOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Injected by the composition root so the SPI client and the organization
   * admin client share ONE cached service-account token. Defaults to a private
   * provider, which is what the unit tests exercise.
   */
  tokens?: ServiceAccountTokenProvider;
};

export function createKeycloakSpiClient(
  config: KeycloakSpiClientConfig,
  options: KeycloakSpiClientOptions = {},
): KeycloakSpiClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const realmBase = `${config.baseUrl}/realms/${encodeURIComponent(config.tenantRealm)}`;

  const tokens =
    options.tokens ??
    createServiceAccountTokenProvider(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      unauthorized: (message, status) =>
        new KeycloakSpiError("KEYCLOAK_SPI_UNAUTHORIZED", message, status),
      unavailable: (message, status) =>
        new KeycloakSpiError("KEYCLOAK_SPI_UNAVAILABLE", message, status),
    });

  async function post(path: string, payload: unknown): Promise<unknown> {
    const token = await tokens.get();
    let response: Response;
    try {
      response = await doFetch(`${realmBase}/openshapeforge/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakSpiError(
        "KEYCLOAK_SPI_UNAVAILABLE",
        `Could not reach the identity-configuration SPI at ${realmBase}/openshapeforge/${path}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const body = await readJson(response);
    if (response.ok) return body;

    if (response.status === 401 || response.status === 403) {
      // The token authenticated somewhere but the SPI refused it. In practice:
      // the service account lost realm-management manage-realm, or the client is
      // no longer in ALLOWED_ADMIN_CLIENTS. Drop the cached token so a rotated
      // credential is picked up without a restart.
      tokens.invalidate();
      throw new KeycloakSpiError(
        "KEYCLOAK_SPI_UNAUTHORIZED",
        `The identity-configuration SPI refused "${config.clientId}": ` +
          `${describeError(body, response.statusText)}. The service account must be ` +
          "allow-listed by the SPI and hold realm-management manage-realm.",
        response.status,
      );
    }
    if (response.status === 409) {
      throw new KeycloakSpiError(
        "KEYCLOAK_SPI_CONFLICT",
        describeError(body, "The organization conflicts with an existing one."),
        response.status,
      );
    }
    if (response.status === 400) {
      throw new KeycloakSpiError(
        "KEYCLOAK_SPI_REJECTED",
        describeError(body, "The identity-configuration SPI rejected the request."),
        response.status,
      );
    }
    throw new KeycloakSpiError(
      "KEYCLOAK_SPI_UNAVAILABLE",
      `The identity-configuration SPI answered ${response.status}: ` +
        describeError(body, response.statusText),
      response.status,
    );
  }

  return {
    async createOrganization(request) {
      // Mirror the SPI's own precondition rather than letting it round-trip: a
      // sub-organization without a parent or root is a programming error here,
      // not an operator input error, and the local message names which one.
      if (request.organizationLevel === "sub") {
        if (!request.parentOrganizationId || !request.rootOrganizationId) {
          throw new KeycloakSpiError(
            "KEYCLOAK_SPI_REJECTED",
            "A sub-organization needs both parentOrganizationId and rootOrganizationId.",
          );
        }
      } else if (request.parentOrganizationId) {
        throw new KeycloakSpiError(
          "KEYCLOAK_SPI_REJECTED",
          "A root organization cannot have a parentOrganizationId.",
        );
      }

      const body = (await post("organizations", request)) as
        | Record<string, unknown>
        | undefined;
      const id = body?.id ?? body?.organizationId;
      if (typeof id !== "string" || id.length === 0) {
        throw new KeycloakSpiError(
          "KEYCLOAK_SPI_UNAVAILABLE",
          "The identity-configuration SPI returned an organization with no id.",
        );
      }
      return {
        id,
        alias: typeof body?.alias === "string" ? body.alias : request.alias,
        name: typeof body?.name === "string" ? body.name : request.name,
      };
    },
  };
}
