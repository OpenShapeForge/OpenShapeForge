// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { readManagedMaintenanceConfiguration } from "../maintenance.js";

const env = {
  OPENSHAPEFORGE_PUBLIC_ORIGIN: "https://app.example.test",
  OPENSHAPEFORGE_MCP_CLIENTS: "web",
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "https://identity.example.test/auth/",
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM: "example",
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID: "client",
  KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API: "test-only",
  OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE: "fixture",
  OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE_ROLE: "fixture",
};

test("managed maintenance preserves only a safe HTTPS Keycloak path", () => {
  expect(readManagedMaintenanceConfiguration(env).keycloak.baseUrl).toBe("https://identity.example.test/auth");
  for (const base of ["http://identity.example.test/auth", "https://user:pass@identity.example.test/auth", "https://identity.example.test/auth?x=1", "https://identity.example.test/auth#x"]) {
    expect(() => readManagedMaintenanceConfiguration({...env, OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: base})).toThrow();
  }
  expect(() => readManagedMaintenanceConfiguration({...env, OPENSHAPEFORGE_PUBLIC_ORIGIN: "https://app.example.test/path"})).toThrow();
});
