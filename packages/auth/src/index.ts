export type {
  AuthIdentity,
  AuthProfile,
  TrustedContextHeaderNames,
} from "./types.js";

export {
  parseAuthIdentity,
  parseClientRoles,
  parseGroups,
  parseRoles,
  parseScopes,
  parseTenantContext,
  parseTenantId,
  parseUserProfile,
  readJwtClaims,
} from "./claims.js";

export {
  TRUSTED_CONTEXT_HEADERS,
  TRUSTED_CONTEXT_MAX_AGE_MS,
  applyTrustedContextHeaders,
  hasValidTrustedContextSignature,
  readTrustedContext,
} from "./trusted-context.js";

export type {
  ApplyTrustedContextOptions,
  ReadTrustedContextOptions,
} from "./trusted-context.js";

export { createBearerVerifier } from "./bearer.js";
export type {
  BearerVerifier,
  BearerVerifierOptions,
} from "./bearer.js";
