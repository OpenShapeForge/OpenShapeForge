// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform administrator's side of the elevation, and the party
 * allow-list the control plane admits MCP clients on. Who gets through the
 * door is control-session.unit.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { SYSTEM_BYPASS_ROLE } from "../../db/session.js";
import { platformMcpAuthorizedParties, readControlPlaneConfig, type ControlPlaneConfig } from "../config.js";
import { systemSessionForAdministrator } from "../platform-admin.js";

const ISSUER = "http://localhost:8181/realms/openshapeforge-control";
const GATEWAY = "openshapeforge-admin-gateway";
const CODEX = "codex-platform";
const SUBJECT = "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10";

const config: ControlPlaneConfig = {
  keycloak: {
    baseUrl: "http://localhost:8181",
    tenantRealm: "openshapeforge",
    clientId: "openshapeforge-auth-api",
    clientSecret: "s3cret",
  },
  operator: {
    issuer: ISSUER,
    jwksUri: `${ISSUER}/protocol/openid-connect/certs`,
    clientId: GATEWAY,
  },
  mcpResource: { origins: ["http://127.0.0.1:3001"], clients: ["codex"] },
  platformMcp: { authorizedParties: [GATEWAY, CODEX] },
};

describe("platformMcpAuthorizedParties", () => {
  it("reads a comma-separated list from the environment and trims it", () => {
    const result = readControlPlaneConfig({
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "http://localhost:8181",
      KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API: "s",
      OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER: ISSUER,
      OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI: `${ISSUER}/certs`,
      OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID: GATEWAY,
      OPENSHAPEFORGE_PUBLIC_ORIGIN: "http://127.0.0.1:3001",
      OPENSHAPEFORGE_CONTROL_MCP_AUTHORIZED_PARTIES: ` ${GATEWAY}, ${CODEX} ,`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(platformMcpAuthorizedParties(result.config)).toEqual([GATEWAY, CODEX]);
  });

  it("defaults to the operator client alone", () => {
    expect(platformMcpAuthorizedParties({ ...config, platformMcp: { authorizedParties: [] } })).toEqual([GATEWAY]);
  });
});

describe("systemSessionForAdministrator", () => {
  const admin = {
    subject: SUBJECT,
    issuer: ISSUER,
    username: "hubble-platform-admin",
    name: "Hubble Platform admin",
    email: null,
    authorizedParty: CODEX,
    expiresAtMs: null,
  };

  it("elevates to the bypass role with an issuer-qualified actor and a platform-mcp reason", () => {
    const session = systemSessionForAdministrator(admin, "control.publish-catalog-entry service/record-finding");
    expect(session.roles).toEqual([SYSTEM_BYPASS_ROLE]);
    expect(session.actorSubject).toBe(`${ISSUER}#${SUBJECT} (hubble-platform-admin)`);
    expect(session.reason).toBe("platform-mcp: control.publish-catalog-entry service/record-finding");
    expect(session.tenantId).toBeUndefined();
  });

  it("refuses an empty reason", () => {
    expect(() => systemSessionForAdministrator(admin, " ")).toThrow(/non-empty reason/);
  });
});
