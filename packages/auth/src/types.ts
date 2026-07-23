export type AuthProfile = {
  name?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  preferredUsername?: string;
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
