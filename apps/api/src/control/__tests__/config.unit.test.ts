// SPDX-License-Identifier: BUSL-1.1
/**
 * Control-plane configuration: all-or-nothing, and never the tenant realm's.
 *
 * The failure this guards is a half-configured control plane — specifically the
 * shape where the SPI secret is absent and provisioning writes the database
 * while Keycloak silently never happens. So there is no partial success: every
 * missing variable is reported at once, and the route layer refuses on the list.
 */
import { describe, expect, it } from "bun:test";
import { readControlPlaneConfig, type ControlPlaneEnv } from "../config.js";

const complete: ControlPlaneEnv = {
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "http://localhost:8181",
  KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API: "openshapeforge-auth-api-secret",
  OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER:
    "http://localhost:8181/realms/openshapeforge-control",
  OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI:
    "http://localhost:8181/realms/openshapeforge-control/protocol/openid-connect/certs",
  OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID: "openshapeforge-admin-gateway",
};

describe("readControlPlaneConfig", () => {
  it("reads a complete configuration and applies the defaults", () => {
    const result = readControlPlaneConfig(complete);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.keycloak.tenantRealm).toBe("openshapeforge");
    expect(result.config.keycloak.clientId).toBe("openshapeforge-auth-api");
    expect(result.config.operator.clientId).toBe("openshapeforge-admin-gateway");
  });

  it("reports every missing variable at once", () => {
    const result = readControlPlaneConfig({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([
      "OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL",
      "KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API",
      "OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER",
      "OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI",
      "OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID",
    ]);
  });

  it("refuses a configuration missing only the SPI secret", () => {
    // The dangerous half-configuration: operator sign-in would work and every
    // provisioning call would half-apply.
    const result = readControlPlaneConfig({
      ...complete,
      KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API"]);
  });

  it("requires the operator client id, which pins azp", () => {
    const result = readControlPlaneConfig({
      ...complete,
      OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID: "   ",
    });

    expect(result.ok).toBe(false);
  });

  it("normalises a trailing slash off the Keycloak base URL", () => {
    const result = readControlPlaneConfig({
      ...complete,
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "http://localhost:8181///",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.keycloak.baseUrl).toBe("http://localhost:8181");
  });

  it("honours an overridden tenant realm and SPI client id", () => {
    const result = readControlPlaneConfig({
      ...complete,
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM: "acme-tenants",
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID: "acme-auth-api",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.keycloak.tenantRealm).toBe("acme-tenants");
    expect(result.config.keycloak.clientId).toBe("acme-auth-api");
  });
});
