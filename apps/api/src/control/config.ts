// SPDX-License-Identifier: BUSL-1.1
/**
 * Deployment configuration for the tenant control plane.
 *
 * Two independent halves, both required, and neither of them the tenant realm's
 * configuration:
 *
 *   - OPERATOR VERIFICATION. Operators sign in against the CONTROL realm
 *     (`openshapeforge-control`), which is a different issuer from the tenant realm
 *     `apps/api` verifies everywhere else. Reusing
 *     OPENSHAPEFORGE_API_VERIFY_BEARER_* here would accept a TENANT user's token on
 *     the control surface — the exact confusion the second realm exists to make
 *     impossible — so the control surface pins its own issuer, JWKS and client.
 *
 *   - SPI CREDENTIALS. Provisioning reaches the identity-configuration SPI in the
 *     TENANT realm with the `openshapeforge-auth-api` service account's client
 *     credentials. This is structural, not a shortcut: the SPI is a
 *     RealmResourceProvider whose `requireAdminBearer()` authenticates the bearer
 *     against the *target* realm and additionally demands
 *     realm-management `manage-realm`, so a control-realm operator token can never
 *     call it. The operator's own token is never forwarded.
 *
 * ALL-OR-NOTHING. A half-configured control plane is a worse failure than an
 * absent one — it is the shape where the SPI secret is missing and provisioning
 * appears to "work" against the database while Keycloak silently never happens.
 * So this reports the complete list of missing variables and the route layer
 * refuses every request with it, rather than degrading to a partial surface.
 * Nothing here throws at import time: an existing deployment that never sets any
 * of it must keep starting exactly as before, with the control routes answering
 * 503 and saying why.
 */

/** Environment variables the control plane reads. */
export type ControlPlaneEnv = {
  /** Keycloak origin, e.g. `http://localhost:8181`. No trailing path. */
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL?: string | undefined;
  /** The realm holding tenant Organizations and the SPI. Defaults to `openshapeforge`. */
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM?: string | undefined;
  /**
   * The service-account client the SPI allow-lists. Defaults to
   * `openshapeforge-auth-api`, which is the ONLY value
   * `OpenShapeForgeResource.ALLOWED_ADMIN_CLIENTS` accepts today; it is
   * configurable so a deployment that renames the client is not forced to fork
   * the code, not because another client would work.
   */
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID?: string | undefined;
  /**
   * That client's secret. Deliberately the SAME variable name the realm
   * generator emits for it (`authorization.yaml` →
   * `secret: ${env:KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API}`), so one
   * credential has one name across realm import and runtime instead of two that
   * can drift apart.
   */
  KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API?: string | undefined;
  /** Control-realm issuer, e.g. `http://localhost:8181/realms/openshapeforge-control`. */
  OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER?: string | undefined;
  /** Control-realm JWKS endpoint. */
  OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI?: string | undefined;
  /**
   * The ONE client whose tokens the control surface accepts, matched against
   * `azp`. Required.
   *
   * Why `azp` and not `aud`, which is what the tenant surface pins. The tenant
   * surface pins `erp-provider` — a RESOURCE-server client that lands in `aud`
   * because the gateway's composite roles reach its client roles. The control
   * realm has no resource client at all: it holds one interactive gateway client
   * and one realm role with no composites, so nothing ever populates `aud` and a
   * real operator token carries none (verified against the running realm).
   * Pinning an absent claim would reject every operator; leaving it unpinned
   * would accept a token minted by Keycloak's built-in PUBLIC `admin-cli`
   * client, which any realm user can obtain with a direct-access grant and no
   * client secret. `azp` names the party the token was actually minted for, so
   * it is the claim that distinguishes them — the same reasoning, and the same
   * admin-cli hazard, that `OpenShapeForgeResource.ALLOWED_ADMIN_CLIENTS` is
   * built on. If the control realm ever gains a resource-server client, `aud`
   * becomes the better pin and this should move.
   */
  OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID?: string | undefined;
  /**
   * The clients whose tokens the platform administrator MCP
   * (`/api/control/mcp`, `mcp/control-mcp-server.ts`) accepts, matched
   * against `azp`, comma-separated. Optional; defaults to the operator client
   * above. An MCP client signs in interactively with a public PKCE client of
   * the control realm (`codex-platform` in the reference realm setup), which
   * is a different party from the admin gateway, so the allow-list is a list.
   * The `admin-cli` hazard the CLIENT_ID pin closes applies unchanged: a name
   * that is not on this list is refused before any role is looked at.
   */
  OPENSHAPEFORGE_CONTROL_MCP_AUTHORIZED_PARTIES?: string | undefined;
};

export type ControlPlaneConfig = {
  keycloak: {
    baseUrl: string;
    tenantRealm: string;
    clientId: string;
    clientSecret: string;
  };
  operator: {
    issuer: string;
    jwksUri: string;
    /** Matched against the token's `azp`. See ControlPlaneEnv for why not `aud`. */
    clientId: string;
  };
  /**
   * The platform administrator MCP's `azp` allow-list. Absent means "the
   * operator client only" (`platformMcpAuthorizedParties` applies that
   * default), so a configuration literal built before this field existed
   * keeps its meaning.
   */
  platformMcp?: {
    authorizedParties: readonly string[];
  };
};

/** The `azp` values `/api/control/mcp` admits, with the default applied. */
export function platformMcpAuthorizedParties(config: ControlPlaneConfig): readonly string[] {
  const configured = config.platformMcp?.authorizedParties ?? [];
  return configured.length > 0 ? configured : [config.operator.clientId];
}

export type ControlPlaneConfigResult =
  | { ok: true; config: ControlPlaneConfig }
  | { ok: false; missing: string[] };

const DEFAULT_TENANT_REALM = "openshapeforge";
const DEFAULT_SPI_CLIENT_ID = "openshapeforge-auth-api";

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function readControlPlaneConfig(
  env: ControlPlaneEnv = process.env as ControlPlaneEnv,
): ControlPlaneConfigResult {
  const baseUrl = trimmed(env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL);
  const clientSecret = trimmed(env.KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API);
  const issuer = trimmed(env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER);
  const jwksUri = trimmed(env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI);
  const operatorClientId = trimmed(env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID);

  // Reported together, never one at a time: an operator fixing a control-plane
  // rollout should learn everything that is missing from one 503, not discover
  // the next gap after each restart.
  const missing: string[] = [];
  if (!baseUrl) missing.push("OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL");
  if (!clientSecret) missing.push("KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API");
  if (!issuer) missing.push("OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER");
  if (!jwksUri) missing.push("OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI");
  if (!operatorClientId) missing.push("OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID");
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    config: {
      keycloak: {
        // Normalised once here so every caller can join paths without guessing
        // whether the operator wrote a trailing slash.
        baseUrl: baseUrl!.replace(/\/+$/, ""),
        tenantRealm:
          trimmed(env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM) ?? DEFAULT_TENANT_REALM,
        clientId:
          trimmed(env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID) ?? DEFAULT_SPI_CLIENT_ID,
        clientSecret: clientSecret!,
      },
      operator: { issuer: issuer!, jwksUri: jwksUri!, clientId: operatorClientId! },
      platformMcp: {
        authorizedParties: (env.OPENSHAPEFORGE_CONTROL_MCP_AUTHORIZED_PARTIES ?? "")
          .split(",")
          .map((party) => party.trim())
          .filter((party) => party.length > 0),
      },
    },
  };
}
