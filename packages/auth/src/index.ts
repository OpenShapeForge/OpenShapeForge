// SPDX-License-Identifier: BUSL-1.1
export type {
  AuthIdentity,
  AuthProfile,
  HeadersLike,
  OrganizationAccess,
  ReadonlyHeadersLike,
  TrustedContextHeaderNames,
} from "./types.js";

export {
  parseAuthIdentity,
  parseClientRoles,
  parseGroups,
  parseOrganizations,
  parseRoles,
  parseScopes,
  parseTenantContext,
  parseTenantId,
  parseUserProfile,
  readJwtClaims,
} from "./claims.js";

export {
  ORGANIZATION_TENANT_CACHE_TTL_MS,
  organizationTenantCacheKey,
  realmFromIssuer,
  selectOrganizationMembership,
} from "./organization-tenant.js";

export {
  TRUSTED_CONTEXT_HEADERS,
  TRUSTED_CONTEXT_MAX_AGE_MS,
  TRUSTED_CONTEXT_MAX_CLOCK_SKEW_MS,
  applyTrustedContextHeaders,
  hasValidTrustedContextSignature,
  readTrustedContext,
} from "./trusted-context.js";

export type {
  ApplyTrustedContextOptions,
  ReadTrustedContextOptions,
} from "./trusted-context.js";

export {
  BearerVerifierUnavailableError,
  createBearerVerifier,
} from "./bearer.js";
export type {
  BearerVerifier,
  BearerVerifierOptions,
} from "./bearer.js";
