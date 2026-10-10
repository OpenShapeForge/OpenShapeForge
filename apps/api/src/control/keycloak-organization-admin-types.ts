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
import type { ServiceAccountTokenProvider } from "./keycloak-service-account.js";
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

/** Fixed, non-identifying names for the Keycloak admin subcall that failed. */
export type KeycloakAdminOperation =
  | "service_account_token"
  | "invite_existing_member"
  | "get_organization"
  | "get_organization_for_update"
  | "update_organization"
  | "list_organizations"
  | "link_identity_provider"
  | "list_identity_providers"
  | "unlink_identity_provider"
  | "check_invitation_smtp"
  | "resolve_role_client"
  | "list_organization_members"
  | "list_member_roles"
  | "list_invitations"
  | "invite_member"
  | "resend_invitation"
  | "delete_invitation"
  | "get_member"
  | "list_member_credentials"
  | "list_member_federated_identities"
  | "delete_member_credential"
  | "remove_organization_member"
  | "send_passkey_recovery"
  | "send_password_recovery";

export class KeycloakAdminError extends Error {
  readonly code: KeycloakAdminErrorCode;
  /** Upstream HTTP status, when there was a response at all. */
  readonly status: number | undefined;
  /** Safe fixed tag: never a URL, organization id, address, or response body. */
  readonly operation: KeycloakAdminOperation | undefined;
  /** Wall-clock duration of only the failed Keycloak subcall. */
  readonly durationMs: number | undefined;

  constructor(
    code: KeycloakAdminErrorCode,
    message: string,
    status?: number,
    diagnostic?: { operation: KeycloakAdminOperation; durationMs: number },
  ) {
    super(message);
    this.name = "KeycloakAdminError";
    this.code = code;
    this.status = status;
    this.operation = diagnostic?.operation;
    this.durationMs = diagnostic?.durationMs;
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

/** One identity provider linked to an Organization, as the native endpoint reports it. */
export type OrganizationIdentityProvider = {
  alias: string;
  providerId: string;
  enabled: boolean;
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
  /**
   * Link an identity provider — already authored in the realm (see
   * docs/identity-providers.md) — to this Organization, via Keycloak's native
   * `POST /organizations/{id}/identity-providers`. Realm-wide
   * `identityProviders[]` authors WHAT a provider is; this is the ONLY thing
   * that decides WHICH Organization brokers through it. Idempotent: linking
   * an alias already linked to this Organization is a no-op (Keycloak answers
   * 204 either way; verified there is no distinguishable "already linked"
   * error on 26.5.3, so no such re-signal is invented here).
   */
  linkIdentityProvider(organizationId: string, alias: string): Promise<void>;
  /** Identity providers currently linked to this Organization. */
  listIdentityProviders(organizationId: string): Promise<OrganizationIdentityProvider[]>;
  /** Unlink an identity provider from this Organization. Idempotent. */
  unlinkIdentityProvider(organizationId: string, alias: string): Promise<void>;
};

export type KeycloakOrganizationAdminOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Shared with the SPI client so one token serves both. */
  tokens?: ServiceAccountTokenProvider;
};
