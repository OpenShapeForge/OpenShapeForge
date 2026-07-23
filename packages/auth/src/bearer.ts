// SPDX-License-Identifier: BUSL-1.1
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { parseAuthIdentity } from "./claims.js";
import type { AuthIdentity } from "./types.js";

type BaseVerifierOptions = {
  issuer: string;
  /**
   * Expected `aud` claim. Verifying audience prevents tokens minted for
   * sibling clients from being accepted by this service.
   */
  audience?: string | string[];
};

type RemoteJwksOptions = BaseVerifierOptions & { jwksUri: string };

type LocalJwksOptions = BaseVerifierOptions & {
  /** Pre-built key set, used in tests to bypass the HTTPS JWKS fetch. */
  keySet: JWTVerifyGetKey;
};

export type BearerVerifierOptions = RemoteJwksOptions | LocalJwksOptions;

export type BearerVerifier = (token: string) => Promise<{
  identity: AuthIdentity;
  claims: JWTPayload;
}>;

/**
 * Builds a JWT bearer verifier. Production callers pass `jwksUri` (the IdP's
 * JWKS endpoint); jose caches keys per-process so the network fetch only
 * happens on key rotation. Tests pass `keySet` from `jose.createLocalJWKSet`.
 *
 * The returned verifier throws on any verification failure (signature,
 * issuer mismatch, audience mismatch, expired token). Callers should treat
 * the throw as "401 — invalid token."
 */
export function createBearerVerifier(options: BearerVerifierOptions): BearerVerifier {
  const keySet: JWTVerifyGetKey =
    "keySet" in options
      ? options.keySet
      : createRemoteJWKSet(new URL(options.jwksUri));

  const verifyOptions: { issuer: string; audience?: string | string[] } = {
    issuer: options.issuer,
  };
  if (options.audience !== undefined) verifyOptions.audience = options.audience;

  return async function verify(token) {
    const { payload } = await jwtVerify(token, keySet, verifyOptions);
    return {
      identity: parseAuthIdentity(payload as Record<string, unknown>),
      claims: payload,
    };
  };
}
