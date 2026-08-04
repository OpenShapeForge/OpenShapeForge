// SPDX-License-Identifier: BUSL-1.1
/**
 * Reading and enabling/disabling a tenant's Keycloak Organization, over
 * Keycloak's OWN admin API (`/admin/realms/{realm}/organizations/{id}`).
 *
 * ── WHY SUSPENSION GOES THROUGH THIS AND NOT THE SPI ────────────────────────
 *
 * A suspended tenant has to mean something on the Keycloak side; leaving it
 * implicit was called out on the plan (#286) as the thing not to do. The state
 * it maps onto is `OrganizationModel.enabled`, which Keycloak already models,
 * already persists, and already exposes — `OpenShapeForgeResource` even calls
 * `setEnabled(true)` on every create.
 *
 * So the choice was between adding an enable/disable route to the SPI and
 * calling the endpoint Keycloak ships. The SPI exists for what Keycloak has NO
 * concept of: the parent/root/path attributes that make a hierarchy out of a
 * flat organization list. `enabled` is not that. And the cost of an SPI route
 * is not one Java method — it is a jar rebuild plus a Keycloak image rebuild
 * against the exact runtime version, on a jar that links non-public server SPIs
 * with no cross-minor stability (`AdminPermissions` moved packages between 26.1
 * and 26.5 and broke a fix at runtime while compiling fine). Paying that to
 * re-expose a native endpoint would be a bad trade. **No SPI change was made
 * and none is needed** — the admin API is reached with the same
 * `openshapeforge-auth-api` service account, whose `realm-management`
 * `manage-realm` is exactly the permission the organizations admin resource
 * requires. Verified against the running Keycloak 26.5.3.
 *
 * ── WHAT DISABLING AN ORGANIZATION DOES, AND WHAT IT DOES NOT ───────────────
 *
 * Established against Keycloak 26.5.3 by adding a real member and minting real
 * tokens, not from documentation. Two facts, and the second is the useful one:
 *
 *   1. A member of a DISABLED organization CAN still obtain a token with its
 *      own password. The realm account is untouched, so `enabled` is not a
 *      lockout and a comment claiming it were would be false.
 *   2. The disabled organization DROPS OUT of the `organization` claim. The
 *      same user, the same client, the same credentials: while the
 *      organization was enabled the claim read
 *      `["acme-holding", "1111…"]`, and while disabled it read `["1111…"]` —
 *      the other organization only. Reactivating brought it back.
 *
 * So the projection has real teeth in the direction that matters here:
 * suspension removes the tenant from the organization membership every
 * downstream authorization decision is scoped by, along with the organization's
 * identity providers and the org-aware login flow. What it does NOT do is
 * refuse credential authentication for a user that already exists in the realm.
 *
 * That is the honest scope of it, and it is why `platform.tenants.status` is
 * the authoritative fact and this is its mirror: disabling the Organization is
 * what stops the tenant's identity configuration from being used, and is fully
 * reversible; refusing sign-in outright for a suspended tenant is an
 * application-side gate, and no code reads `tenants.status` at session setup
 * yet.
 *
 * The alternatives were considered and rejected: disabling each member user is
 * user management (explicitly out of v1 scope on #286), is not cleanly
 * reversible because it cannot tell which users were already disabled, and
 * would be reaching into a membership set this system does not populate;
 * removing members is destructive.
 *
 * ── WHY EVERY WRITE IS READ-MODIFY-WRITE ────────────────────────────────────
 *
 * `PUT /organizations/{id}` takes a whole representation. Keycloak 26.5.3
 * happens to leave attributes alone when the body omits them, but the
 * `openshapeforge.*` hierarchy attributes are the only thing holding the
 * sub-org tree together, and staking them on an undocumented merge behaviour of
 * one patch version is not a bet worth taking. So the current representation is
 * fetched, one field is changed, and the whole thing is written back.
 *
 * ── WHY THE HIERARCHY ATTRIBUTES ARE READ HERE, AND ONLY FOR S7 ─────────────
 *
 * `getOrganization` deliberately does NOT interpret `attributes`: it carries
 * them through the read-modify-write untouched, because interpreting them is
 * the SPI's job and a second reading of them is how two sources of truth start.
 * {@link KeycloakOrganizationAdminClient.listOrganizations} is the one
 * exception, and it exists for exactly one caller — `reconciliation.ts`, whose
 * whole purpose is to COMPARE what Keycloak holds against what the registry
 * says it should hold. A comparison cannot be made without reading both sides,
 * and `keycloak-spi-client.ts` says in as many words that the persisted state
 * must be read back through the admin API when S7 needs it. Nothing else may
 * read {@link KeycloakOrganizationSnapshot}'s attribute fields, and nothing
 * WRITES them here: re-applying goes back through the SPI, which owns them.
 *
 * The listing asks for `briefRepresentation=false` because the brief form omits
 * `attributes` entirely — verified against the running Keycloak 26.5.3, where
 * the default listing returns `{id, name, alias, enabled}` and nothing else.
 * The alternative would be one `GET /organizations/{id}` per organization,
 * which is the same data at N round trips.
 */
import {
  createServiceAccountTokenProvider,
  describeError,
  readJson,
  REQUEST_TIMEOUT_MS,
  type KeycloakServiceAccountConfig,
  type ServiceAccountTokenProvider,
} from "./keycloak-service-account.js";

export type KeycloakAdminErrorCode =
  /**
   * The registry holds an organization id Keycloak does not have. Genuine
   * drift, not a bad request — the caller named a tenant, not an organization.
   */
  | "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND"
  /** Keycloak validated the representation and refused it. */
  | "KEYCLOAK_ADMIN_REJECTED"
  /**
   * The service account could not authenticate or lacks `manage-realm`. Not the
   * operator's fault and not fixable by retrying — a deployment fault.
   */
  | "KEYCLOAK_ADMIN_UNAUTHORIZED"
  /** Anything else: unreachable, 5xx, unparseable body. */
  | "KEYCLOAK_ADMIN_UNAVAILABLE";

export class KeycloakAdminError extends Error {
  readonly code: KeycloakAdminErrorCode;
  /** Upstream HTTP status, when there was a response at all. */
  readonly status: number | undefined;

  constructor(code: KeycloakAdminErrorCode, message: string, status?: number) {
    super(message);
    this.name = "KeycloakAdminError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The subset of `OrganizationRepresentation` this module reads back and hands
 * on. Deliberately not the whole thing: `attributes` is carried through the
 * read-modify-write untouched and never interpreted here, because interpreting
 * the hierarchy attributes is the SPI's job and duplicating that reading is how
 * two sources of truth start.
 */
export type KeycloakOrganizationState = {
  id: string;
  name: string;
  alias: string;
  enabled: boolean;
};

/**
 * The `openshapeforge.*` organization attributes the SPI writes, named here so
 * the drift report reads the same keys `OpenShapeForgeResource.java` writes.
 * Mirrored rather than shared because the SPI is a Java artifact in a different
 * package with its own build; the constants below and
 * `ATTR_ORGANIZATION_LEVEL`/`ATTR_ORGANIZATION_PATH`/`ATTR_PARENT_ORGANIZATION_ID`/
 * `ATTR_ROOT_ORGANIZATION_ID` there are one pair that has to move together.
 *
 * `openshapeforge.sourceAuthority` is deliberately absent: it is a provenance
 * stamp the SPI writes as a constant, so it says nothing about a hierarchy and
 * a mismatch in it would not be drift the registry could describe.
 */
export const ORGANIZATION_ATTRIBUTE_KEYS = {
  level: "openshapeforge.organizationLevel",
  path: "openshapeforge.organizationPath",
  parentOrganizationId: "openshapeforge.parentOrganizationId",
  rootOrganizationId: "openshapeforge.rootOrganizationId",
} as const;

/**
 * An organization as Keycloak actually holds it, hierarchy attributes included.
 *
 * Every attribute field is `string | null` — null meaning "the attribute is not
 * set", which is a MEANINGFUL state rather than a missing value: a root
 * organization has no `parentOrganizationId` at all, and reporting an absent
 * attribute as an empty string would make "unset" and "set to nothing"
 * indistinguishable to the comparison.
 */
export type KeycloakOrganizationSnapshot = KeycloakOrganizationState & {
  organizationLevel: string | null;
  organizationPath: string | null;
  parentOrganizationId: string | null;
  rootOrganizationId: string | null;
};

export type ListOrganizationsResult = {
  organizations: KeycloakOrganizationSnapshot[];
  /** True when the realm holds more organizations than the requested limit. */
  truncated: boolean;
};

export type KeycloakOrganizationAdminClient = {
  /** The organization's current state, or a named error if it is not there. */
  getOrganization(organizationId: string): Promise<KeycloakOrganizationState>;
  /**
   * Bring the organization's `enabled` flag to `enabled`. Idempotent: a
   * no-op when it already matches, so replaying a suspend costs one GET.
   * Returns the state afterwards, and whether a write actually happened.
   */
  setOrganizationEnabled(
    organizationId: string,
    enabled: boolean,
  ): Promise<{ organization: KeycloakOrganizationState; changed: boolean }>;
  /**
   * Every organization in the realm, with its hierarchy attributes.
   *
   * The realm is scanned WHOLE rather than per tenant, because one of the drift
   * classes — an Organization no registry row claims — is only visible from the
   * realm side. There is no per-tenant question that answers it.
   */
  listOrganizations(limit: number): Promise<ListOrganizationsResult>;
};

export type KeycloakOrganizationAdminOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Shared with the SPI client so one token serves both. */
  tokens?: ServiceAccountTokenProvider;
};

export function createKeycloakOrganizationAdminClient(
  config: KeycloakServiceAccountConfig,
  options: KeycloakOrganizationAdminOptions = {},
): KeycloakOrganizationAdminClient {
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
  ): Promise<{ status: number; body: unknown }> {
    const token = await tokens.get();
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
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
      );
    }
    if (response.status === 404) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND",
        "The Keycloak organization this tenant is linked to no longer exists. " +
          "Replay the tenant's provisioning create to recreate and relink it.",
        response.status,
      );
    }
    if (response.status === 400) {
      throw new KeycloakAdminError(
        "KEYCLOAK_ADMIN_REJECTED",
        describeError(body, "The Keycloak admin API rejected the request."),
        response.status,
      );
    }
    throw new KeycloakAdminError(
      "KEYCLOAK_ADMIN_UNAVAILABLE",
      `The Keycloak admin API answered ${response.status}: ` +
        describeError(body, response.statusText),
      response.status,
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
      const { body } = await request(organizationUrl(organizationId), { method: "GET" });
      return toState(body, organizationId);
    },

    async setOrganizationEnabled(organizationId, enabled) {
      const url = organizationUrl(organizationId);
      const { body } = await request(url, { method: "GET" });
      const current = toState(body, organizationId);
      if (current.enabled === enabled) {
        return { organization: current, changed: false };
      }

      // The FULL representation back, with one field changed. See the header:
      // the hierarchy attributes ride along untouched rather than trusting
      // Keycloak to merge a partial body.
      const representation = { ...((body ?? {}) as Record<string, unknown>), enabled };
      await request(url, { method: "PUT", body: JSON.stringify(representation) });
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
      });
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
  };
}
