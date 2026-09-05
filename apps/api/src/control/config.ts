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
import { DEFAULT_MCP_CLIENTS } from "./organization-scopes.js";

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
   * The runtime's own public origin, e.g. `https://api.example.com`. Required:
   * it is the first audience every per-organization MCP scope carries
   * (`<origin>/api/mcp/organizations/<alias>`), and a scope with no audience
   * would let provisioning "succeed" while every token for the resource is
   * refused. The same variable the MCP server reads for its callback URL, so
   * one deployment has one answer to "where am I served".
   */
  OPENSHAPEFORGE_PUBLIC_ORIGIN?: string | undefined;
  /**
   * Optional comma-separated list of ADDITIONAL origins the MCP resources are
   * reachable on (a second ingress, a local port beside the public one). Each
   * one gets its own audience mapper on every organization scope; origins
   * removed from the list are removed from Keycloak on the next reconcile.
   */
  OPENSHAPEFORGE_MCP_RESOURCE_ORIGINS?: string | undefined;
  /**
   * Optional comma-separated `clientId`s the scope is attached to as an
   * optional client scope. Defaults to `codex`, `openshapeforge-gateway`,
   * `openshapeforge-inspector`; a listed client the realm does not have is
   * skipped. The realm's default optional scopes are always extended, so
   * dynamically registered MCP clients need no entry here.
   */
  OPENSHAPEFORGE_MCP_CLIENTS?: string | undefined;
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
  /** What `organization-scopes.ts` provisions per Organization. */
  mcpResource: {
    /** Public origin first, then the additional ones; deduplicated, no trailing slash. */
    origins: string[];
    clients: string[];
  };
};

export type ControlPlaneConfigResult =
  | { ok: true; config: ControlPlaneConfig }
  | { ok: false; missing: string[] };

const DEFAULT_TENANT_REALM = "openshapeforge";
const DEFAULT_SPI_CLIENT_ID = "openshapeforge-auth-api";

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * An origin as the audience needs it: scheme + host (+ port), nothing after.
 * Returns null for anything `new URL` cannot parse or that carries a path,
 * because `https://api.example.com/v1` would produce an audience the resource
 * never derives for itself (`canonicalResourceUri` builds it from the request
 * origin) and every token would be refused with no hint why.
 */
function asOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readControlPlaneConfig(
  env: ControlPlaneEnv = process.env as ControlPlaneEnv,
): ControlPlaneConfigResult {
  const baseUrl = trimmed(env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL);
  const clientSecret = trimmed(env.KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API);
  const issuer = trimmed(env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER);
  const jwksUri = trimmed(env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI);
  const operatorClientId = trimmed(env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID);
  const publicOrigin = trimmed(env.OPENSHAPEFORGE_PUBLIC_ORIGIN);

  // Reported together, never one at a time: an operator fixing a control-plane
  // rollout should learn everything that is missing from one 503, not discover
  // the next gap after each restart.
  const missing: string[] = [];
  if (!baseUrl) missing.push("OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL");
  if (!clientSecret) missing.push("KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API");
  if (!issuer) missing.push("OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER");
  if (!jwksUri) missing.push("OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI");
  if (!operatorClientId) missing.push("OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID");
  if (!publicOrigin) missing.push("OPENSHAPEFORGE_PUBLIC_ORIGIN");

  // A malformed origin is reported in the same list as an absent one: both mean
  // "no audience can be minted", and an operator reads one 503 either way.
  const origins: string[] = [];
  for (const [name, values] of [
    ["OPENSHAPEFORGE_PUBLIC_ORIGIN", publicOrigin ? [publicOrigin] : []],
    ["OPENSHAPEFORGE_MCP_RESOURCE_ORIGINS", commaList(env.OPENSHAPEFORGE_MCP_RESOURCE_ORIGINS)],
  ] as const) {
    for (const value of values) {
      const origin = asOrigin(value);
      if (!origin) {
        missing.push(`${name} (not an origin: "${value}")`);
      } else if (!origins.includes(origin)) {
        origins.push(origin);
      }
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  const clients = commaList(env.OPENSHAPEFORGE_MCP_CLIENTS);

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
      mcpResource: {
        origins,
        clients: clients.length > 0 ? clients : [...DEFAULT_MCP_CLIENTS],
      },
    },
  };
}
