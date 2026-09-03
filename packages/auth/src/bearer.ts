// SPDX-License-Identifier: BUSL-1.1
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { parseAuthIdentity } from "./claims.js";
import type { AuthIdentity } from "./types.js";

type BaseVerifierOptions = {
  issuer: string;
  /**
   * Expected `aud` claim. Verifying audience prevents tokens minted for
   * sibling clients from being accepted by this service.
   */
  audience?: string | string[];
  /**
   * Expected OAuth authorized party (`azp`). When configured, a token without
   * an `azp` string or with an unlisted party is rejected after JWT validation.
   */
  authorizedParties?: string | string[];
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
 * The remote JWKS service could not provide a usable key set.
 *
 * This is deliberately distinct from token verification failures. Callers
 * may surface it as temporary authentication-service unavailability without
 * turning malformed, expired, or incorrectly signed credentials into 5xx
 * responses.
 */
export class BearerVerifierUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("The remote bearer verifier is unavailable.", { cause });
    this.name = "BearerVerifierUnavailableError";
  }
}

const fetchRemoteJwks: FetchImplementation = async (url, options) => {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    throw new BearerVerifierUnavailableError(cause);
  }

  if (response.status !== 200) {
    throw new BearerVerifierUnavailableError(
      new Error(`The JWKS endpoint returned HTTP ${response.status}.`),
    );
  }

  // Validate a clone at the I/O boundary so malformed remote content is
  // distinguishable from a caller-controlled JWT parse or verification error.
  try {
    await response.clone().json();
  } catch (cause) {
    throw new BearerVerifierUnavailableError(cause);
  }

  return response;
};

function createUnavailableAwareRemoteJwkSet(jwksUri: string): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(new URL(jwksUri), {
    [customFetch]: fetchRemoteJwks,
  });

  return async (protectedHeader, token) => {
    try {
      const key = await remote(protectedHeader, token);
      const algorithm = token?.header?.alg ?? protectedHeader?.alg;
      const modulusLength = (key.algorithm as { modulusLength?: unknown }).modulusLength;
      if (
        typeof algorithm === "string" &&
        (algorithm.startsWith("RS") || algorithm.startsWith("PS")) &&
        (typeof modulusLength !== "number" || modulusLength < 2048)
      ) {
        throw new BearerVerifierUnavailableError(
          new TypeError(`${algorithm} remote keys must be at least 2048 bits.`),
        );
      }
      return key;
    } catch (error) {
      if (error instanceof BearerVerifierUnavailableError) throw error;
      // A TypeError at this narrow boundary comes from importing the one
      // matching key supplied by the remote JWKS. Caller-controlled header
      // failures are represented by jose's dedicated no-match/unsupported/
      // multiple-match errors and deliberately pass through unchanged.
      if (
        error instanceof TypeError ||
        error instanceof DOMException ||
        error instanceof errors.JWKSInvalid ||
        error instanceof errors.JWKSTimeout
      ) {
        throw new BearerVerifierUnavailableError(error);
      }
      throw error;
    }
  };
}

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
      : createUnavailableAwareRemoteJwkSet(options.jwksUri);

  const verifyOptions: { issuer: string; audience?: string | string[] } = {
    issuer: options.issuer,
  };
  if (options.audience !== undefined) verifyOptions.audience = options.audience;
  const authorizedParties = options.authorizedParties === undefined
    ? null
    : new Set(
        typeof options.authorizedParties === "string"
          ? [options.authorizedParties]
          : options.authorizedParties,
      );
  if (authorizedParties && [...authorizedParties].some((party) => party.length === 0)) {
    throw new TypeError("authorizedParties entries must be non-empty strings.");
  }

  return async function verify(token) {
    const { payload } = await jwtVerify(token, keySet, verifyOptions);
    if (
      authorizedParties &&
      (typeof payload.azp !== "string" || !authorizedParties.has(payload.azp))
    ) {
      throw new Error("JWT authorized party is not allowed.");
    }
    return {
      identity: parseAuthIdentity(payload as Record<string, unknown>),
      claims: payload,
    };
  };
}
