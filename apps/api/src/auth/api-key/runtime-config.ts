// SPDX-License-Identifier: BUSL-1.1
/**
 * Deployment configuration for API key provisioning.
 *
 * Every value is required and every absence disables the surface rather than
 * half-enabling it: a deployment missing the keyring could still create realm
 * clients but could not store their secrets, which would strand a client in
 * Keycloak for every attempt.
 *
 * Note that the AUTHENTICATION path has its own, narrower requirement (a
 * keyring and a bearer verifier — see identity.ts). A deployment can therefore
 * serve existing keys without exposing provisioning, which is the right shape
 * for an API replica that should not be able to mint credentials.
 */
import { keyringFromEnv, type SecretKeyring } from "../../platform/secrets.js";
import { KeycloakAdmin } from "./keycloak-admin.js";
import {
  readCredentialLifetimePolicy,
  type CredentialLifetimePolicy,
} from "./lifetime.js";

export type ApiKeyProvisioningConfig = {
  keyring: SecretKeyring;
  admin: KeycloakAdmin;
  entityRoleClientId: string;
  /**
   * How long this deployment lets a minted credential live (lifetime.ts).
   * Part of the configuration rather than read at each call site so every
   * minting surface resolves exactly one rule, and so a value the deployment
   * declared but this build will not interpret disables provisioning here —
   * with the keyring and the realm settings — instead of surfacing as a
   * failure on whichever request happens to mint first.
   */
  lifetime: CredentialLifetimePolicy;
};

export type ApiKeyEnv = {
  OPENSHAPEFORGE_API_KEY_SECRET_KEYS?: string | undefined;
  OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS?: string | undefined;
  OPENSHAPEFORGE_API_KEY_DEFAULT_TTL_DAYS?: string | undefined;
  OPENSHAPEFORGE_KEYCLOAK_BASE_URL?: string | undefined;
  OPENSHAPEFORGE_KEYCLOAK_REALM?: string | undefined;
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID?: string | undefined;
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET?: string | undefined;
  OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID?: string | undefined;
  OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE?: string | undefined;
};

/** Returns undefined when provisioning is not configured. Never throws. */
export function readApiKeyProvisioningConfig(
  env: ApiKeyEnv = process.env as ApiKeyEnv,
): ApiKeyProvisioningConfig | undefined {
  let keyring: SecretKeyring | undefined;
  try {
    keyring = keyringFromEnv(env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS);
  } catch {
    keyring = undefined;
  }

  const baseUrl = env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL?.trim();
  const realm = env.OPENSHAPEFORGE_KEYCLOAK_REALM?.trim();
  const clientId = env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID?.trim();
  const clientSecret = env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET?.trim();

  const lifetime = readCredentialLifetimePolicy(env);

  if (!keyring || !baseUrl || !realm || !clientId || !clientSecret || !lifetime) {
    return undefined;
  }

  return {
    keyring,
    admin: new KeycloakAdmin({ baseUrl, realm, clientId, clientSecret,
      apiAudience: env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE?.trim() || undefined }),
    lifetime,
    // The client entity roles live on. Defaults to the shipped realm's
    // entityRoleClient so a standard deployment needs no extra variable.
    entityRoleClientId: env.OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID?.trim() || "erp-provider",
  };
}
