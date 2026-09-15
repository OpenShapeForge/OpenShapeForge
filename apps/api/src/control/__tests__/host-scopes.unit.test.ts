// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { ensureOrganizationScope, reconcileOrganizationScopes, compareOrganizationScopes, type OrganizationScopeAdminClient } from "../organization-scopes.js";
import { buildAuthenticateChallenge, buildProtectedResourceMetadata } from "../../mcp/protected-resource-metadata.js";
import { hostMcpResource } from "../../config/host-organization.js";

const saved = { mode: process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT, origin: process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN };
afterEach(() => {
  if (saved.mode === undefined) delete process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
  else process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = saved.mode;
  if (saved.origin === undefined) delete process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
  else process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = saved.origin;
});
function host() {
  process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://app.example.test";
}
test("tenant lifecycle never reads or mutates OAuth configuration in host mode", async () => {
  host();
  const client = new Proxy({}, { get() { throw new Error("OAuth admin access forbidden"); } }) as OrganizationScopeAdminClient;
  const settings = { origins: ["https://app.example.test"], clients: ["web"] };
  for (const alias of ["alpha", "beta"]) {
    expect(await ensureOrganizationScope(client, alias, settings)).toMatchObject({ scope: "organization", audiences: ["https://app.example.test/api/mcp"], actions: [] });
  }
  expect(await reconcileOrganizationScopes(client, { aliases: ["alpha"], removeOrphans: true }, settings)).toMatchObject({ actions: [], removed: [] });
  expect(await compareOrganizationScopes(client, { aliases: ["alpha"], removeOrphans: true }, settings)).toEqual([]);
});
test("discovery uses one configured resource and generic scope, not attacker Host", () => {
  host();
  const request = { url: "/api/mcp", protocol: "https", headers: { host: "attacker.example.test" } } as never;
  expect(buildProtectedResourceMetadata(request, "https://identity.example.test/realms/example")).toMatchObject({ resource: "https://app.example.test/api/mcp", scopes_supported: ["organization"] });
  expect(buildAuthenticateChallenge(request)).toBe('Bearer resource_metadata="https://app.example.test/.well-known/oauth-protected-resource", scope="organization"');
});
test("host audience fails closed without a valid explicit origin", () => {
  host();
  for (const origin of ["", "https://user:secret@app.example.test", "https://app.example.test/other", "file:///tmp"]) {
    process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = origin;
    expect(() => hostMcpResource()).toThrow();
  }
});
