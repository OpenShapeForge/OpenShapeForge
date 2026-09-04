// SPDX-License-Identifier: BUSL-1.1
export type AuthProfile = {
  name?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  preferredUsername?: string;
};

/**
 * One Keycloak Organization membership as the Organization Membership mapper
 * (and, when configured, the Organization Group Membership mapper) emits it
 * under `organization.<alias>`. `id` is the Organization's immutable Keycloak
 * id — present only when the mapper is configured with "add organization id"
 * — and is the value `platform.tenants.keycloak_organization_id` links to.
 * Roles stay nested per organization: they are organization-local authority
 * and are deliberately NOT merged into `roles` / `clientRoles`.
 */
export type OrganizationAccess = {
  id: string | null;
  groups: string[];
  roles: string[];
  clientRoles: Record<string, string[]>;
};

/**
 * Canonical identity shape produced by every verifier in this package.
 *
 * `tenantId` / `userId` / `roles` are the trusted-context floor — they are
 * what gets carried across in-mesh hops. The remaining fields are populated
 * by bearer verification or Auth.js session hydration; they may be absent
 * when an identity is reconstructed from trusted-context headers alone.
 */
export type AuthIdentity = {
  tenantId: string | null;
  userId: string | null;
  roles: string[];
  /**
   * Keycloak group paths the user belongs to, e.g.
   * "/openshapeforge-demo/tenant-acme/operations". These are raw paths — translation
   * to internal org_unit UUIDs (for RLS `app.user_groups`) happens downstream
   * of identity resolution, against the org-unit lookup table.
   */
  groups?: string[];
  scopes?: string[];
  clientRoles?: Record<string, string[]>;
  /**
   * Keycloak Organization memberships keyed by organization alias, from the
   * `organization` claim. Absent when the token carries none. The session
   * layer resolves the tenant from these when the token has no `tid` claim
   * (apps/api `src/auth/identity.ts`).
   */
  organizations?: Record<string, OrganizationAccess>;
  profile?: AuthProfile;
};

export type TrustedContextHeaderNames = {
  tenantId: string;
  userId: string;
  roles: string;
  groups: string;
  timestamp: string;
  signature: string;
};

/**
 * The read side of the Fetch `Headers` interface, spelled structurally rather
 * than by naming the ambient `Headers` global.
 *
 * Same treatment, and the same reason, as `FetchLike` in
 * `apps/api/src/connectors/executor.ts`: `Headers` exists only once some lib
 * or `@types` package puts it in scope, and nothing in this package's build
 * config guarantees one — `tsconfig.build.json` inherits `lib: ["ES2023"]` and
 * declares no `types`, so naming the global made the build depend on whichever
 * ambient declaration the compiler happened to pick up. A real `Headers`
 * satisfies this.
 */
export type ReadonlyHeadersLike = {
  get(name: string): string | null;
};

/** Adds the mutation this package performs when it signs a bundle. */
export type HeadersLike = ReadonlyHeadersLike & {
  set(name: string, value: string): void;
  delete(name: string): void;
};
