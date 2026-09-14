// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { resolveControlOperator } from "../authorization.js";
import { resolvePlatformAdministrator } from "../platform-admin.js";
import type { ControlPlaneConfig } from "../config.js";
const previous = process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
afterEach(() => {
  if (previous === undefined) delete process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
  else process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = previous;
});
const issuer = "https://identity.example.test/realms/example";
const config: ControlPlaneConfig = {
  keycloak: { baseUrl: "https://identity.example.test", tenantRealm: "example", clientId: "auth-api", clientSecret: "test-only" },
  operator: { issuer, jwksUri: `${issuer}/certs`, clientId: "admin-web" },
  mcpResource: { origins: ["https://app.example.test"], clients: ["web"] },
};
for (const [name, resolve] of [["REST", resolveControlOperator], ["MCP", resolvePlatformAdministrator]] as const) {
  test(`${name} host admin requires built-in role and the same host realm`, async () => {
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
    const claims = { sub: "test-subject", azp: "admin-web", resource_access: { "realm-management": { roles: ["realm-admin"] } } };
    const verifier = (async () => ({ identity: {}, claims })) as never;
    const headers = new Headers({ authorization: "Bearer test-only" });
    expect((await resolve(headers, config, { verifier })).subject).toBe("test-subject");
    await expect(resolve(headers, { ...config, keycloak: { ...config.keycloak, tenantRealm: "other" } }, { verifier })).rejects.toThrow();
    const legacy = (async () => ({ identity: {}, claims: { sub: "test-subject", azp: "admin-web", realm_access: { roles: ["platform_admin", "platform-operator"] } } })) as never;
    await expect(resolve(headers, config, { verifier: legacy })).rejects.toThrow();
  });
}
