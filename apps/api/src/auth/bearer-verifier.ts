// SPDX-License-Identifier: BUSL-1.1
/**
 * The verifiers behind session resolution (see ./identity.ts): the bearer
 * verifiers built from the deployment's JWKS/issuer/audience configuration,
 * and the keyring that protects API key integrations' client secrets. Both
 * are process state, read once and reset only by the test seam.
 */
import { createBearerVerifier, type BearerVerifier } from "@openshapeforge/auth";
import { keyringFromEnv, type SecretKeyring } from "../platform/secrets.js";

let verifierInitialized = false;
let cachedVerifier: BearerVerifier | null = null;
let cachedResourceVerifier: BearerVerifier | null = null;
let cachedOrganizationVerifier: BearerVerifier | null = null;
export function getBearerVerifier(allowResourceClient = false, organizationBound = false): BearerVerifier | null {
  if (verifierInitialized) return organizationBound ? cachedOrganizationVerifier : allowResourceClient ? cachedResourceVerifier : cachedVerifier;
  verifierInitialized = true;

  const jwksUri = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
  const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  const audience = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE;
  const authorizedPartiesValue =
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES;
  const authorizedParties = authorizedPartiesValue === undefined
    ? undefined
    : authorizedPartiesValue
        .split(",")
        .map((party) => party.trim())
        .filter(Boolean);

  if (!jwksUri || !issuer) {
    cachedVerifier = null;
    return null;
  }

  if (!audience) {
    // Bearer verification is configured (JWKS + issuer) but no audience is
    // pinned, so ANY same-issuer Keycloak token — including ones minted for
    // sibling clients — would be accepted. In dev this is a loud warning; in
    // production it is fatal (see config/production-guard.ts assertProductionEnv).
    console.warn(
      "[auth] OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE is unset: bearer tokens are " +
        "accepted from any same-issuer client. Set it to the expected `aud` " +
        "value (e.g. erp-provider). This is fatal in production.",
    );
  }

  cachedVerifier = createBearerVerifier({
    jwksUri,
    issuer,
    ...(audience ? { audience } : {}),
    ...(authorizedParties ? { authorizedParties } : {}),
  });
  // Dynamic OAuth clients cannot appear in a static azp allowlist. This
  // verifier is used ONLY when the caller also requires an exact resource aud;
  // signature, issuer and configured API audience checks still apply.
  cachedResourceVerifier = createBearerVerifier({
    jwksUri,
    issuer,
    ...(audience ? { audience } : {}),
  });
  // Explicit organization resources validate their own exact audience and
  // membership through bindOrganizationResource before producing a session.
  // A web client's azp/API audience is not the authority for these resources.
  cachedOrganizationVerifier = createBearerVerifier({ jwksUri, issuer });
  return organizationBound ? cachedOrganizationVerifier : allowResourceClient ? cachedResourceVerifier : cachedVerifier;
}

let apiKeyKeyringInitialized = false;
let cachedApiKeyKeyring: SecretKeyring | null = null;

/**
 * The keyring protecting API key integrations' Keycloak client secrets.
 *
 * Deliberately its OWN key material rather than the connector keyring: the two
 * subsystems encrypt different things for different reasons, and a compromise
 * of one should not decrypt the other. No fallback — an unset value means API
 * key authentication is simply not configured, and every key presented is
 * rejected.
 */
export function getApiKeyKeyring(): SecretKeyring | null {
  if (apiKeyKeyringInitialized) return cachedApiKeyKeyring;
  apiKeyKeyringInitialized = true;
  try {
    cachedApiKeyKeyring = keyringFromEnv(process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS) ?? null;
  } catch (error) {
    // A malformed keyring must not half-configure the subsystem.
    console.warn(
      "[auth] OPENSHAPEFORGE_API_KEY_SECRET_KEYS is malformed; API key authentication is disabled:",
      error instanceof Error ? error.message : String(error),
    );
    cachedApiKeyKeyring = null;
  }
  return cachedApiKeyKeyring;
}

/** Test-only: reset cached state so env changes are picked up. */
export function __resetBearerVerifiersForTests(): void {
  verifierInitialized = false;
  cachedVerifier = null;
  cachedResourceVerifier = null;
  cachedOrganizationVerifier = null;
  apiKeyKeyringInitialized = false;
  cachedApiKeyKeyring = null;
}
