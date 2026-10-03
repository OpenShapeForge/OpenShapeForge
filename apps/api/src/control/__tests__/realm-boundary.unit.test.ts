// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { assertHostRealm, hasKeycloakRealmAdmin } from "../realm-boundary.js";
import type { ControlPlaneConfig } from "../config.js";

function config(realm = "example", issuer = `https://identity.example.test/realms/${realm}`): ControlPlaneConfig {
  return {
    keycloak: { baseUrl: "https://identity.example.test", tenantRealm: realm, clientId: "auth-api", clientSecret: "test-only" },
    operator: { issuer, jwksUri: `${issuer}/certs`, clientId: "web" },
    mcpResource: { origins: ["https://app.example.test"], clients: ["web"] },
  };
}

describe("host realm boundary", () => {
  test("accepts only the exact host issuer", () => {
    expect(() => assertHostRealm(config())).not.toThrow();
    for (const issuer of ["https://other.example.test/realms/example", "https://identity.example.test/realms/other", "https://identity.example.test/realms/example/extra"]) {
      expect(() => assertHostRealm(config("example", issuer))).toThrow();
    }
  });
  test("never admits master or path aliases", () => {
    for (const realm of ["master", "MASTER", "", ".", "..", "example/other", "example%2Fother"]) expect(() => assertHostRealm(config(realm))).toThrow();
  });
  test("requires the exact built-in client role", () => {
    expect(hasKeycloakRealmAdmin({ resource_access: { "realm-management": { roles: ["realm-admin"] } } })).toBe(true);
    for (const claims of [{}, { realm_access: { roles: ["realm-admin", "platform-operator"] } }, { resource_access: { other: { roles: ["realm-admin"] } } }, { resource_access: { "realm-management": { roles: ["manage-users"] } } }, { resource_access: { "realm-management": { roles: "realm-admin" } } }]) {
      expect(hasKeycloakRealmAdmin(claims)).toBe(false);
    }
  });
});
