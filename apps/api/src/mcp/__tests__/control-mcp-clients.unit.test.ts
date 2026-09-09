// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { ControlPlaneConfig } from "../../control/config.js";
import { KeycloakAdminError } from "../../control/keycloak-organization-admin.js";
import { KeycloakSpiError } from "../../control/keycloak-spi-client.js";
import { createPlatformKeycloakClients } from "../control-mcp-server.js";

const config: ControlPlaneConfig = {
  keycloak: {
    baseUrl: "https://keycloak.example",
    tenantRealm: "openshapeforge",
    clientId: "openshapeforge-auth-api",
    clientSecret: "secret",
  },
  operator: {
    issuer: "https://keycloak.example/realms/control",
    jwksUri: "https://keycloak.example/realms/control/protocol/openid-connect/certs",
    clientId: "admin-gateway",
  },
  mcpResource: { origins: ["https://app.example"], clients: ["assistant"] },
};

describe("platform MCP Keycloak client composition", () => {
  test("keeps service-account refusals typed for the API that made the call", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: "unauthorized_client" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const clients = createPlatformKeycloakClients(config, { fetch });

    await expect(
      clients.firstAdministrator.organizations.getOrganization("organization-id"),
    ).rejects.toBeInstanceOf(KeycloakAdminError);
    await expect(
      clients.control.keycloak.createOrganization({
        alias: "acme",
        name: "Acme",
        organizationLevel: "root",
        organizationPath: "acme",
      }),
    ).rejects.toBeInstanceOf(KeycloakSpiError);
  });
});
