// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createKeycloakOrganizationMembersClient } from "../keycloak-organization-members.js";

const config = { baseUrl: "https://keycloak.example", tenantRealm: "tenant", clientId: "admin", clientSecret: "test-only" };
function client(federation: () => Response, member = true) {
  const calls: string[] = [];
  const fetch = (async (input: unknown) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/token")) return Response.json({ access_token: "test-only", expires_in: 60 });
    if (url.includes("/organizations/org%2Facme/members?")) return Response.json(member ? [{ id: "user/one", email: "one@example.test" }] : []);
    if (url.endsWith("/users/user%2Fone/federated-identity")) return federation();
    throw new Error("Unexpected endpoint");
  }) as typeof globalThis.fetch;
  return { adapter: createKeycloakOrganizationMembersClient(config, { fetch }), calls };
}
test("proves the organization before reading aliases and strips all upstream identity details", async () => {
  const { adapter, calls } = client(() => Response.json([
    { identityProvider: "google-workspace", userId: "upstream-private", userName: "private@example.test" },
    { identityProvider: "microsoft" }, { identityProvider: "google-workspace" },
  ]));
  expect(await adapter.listFederatedIdentities!("org/acme", "user/one")).toEqual([{ alias: "google-workspace" }, { alias: "microsoft" }]);
  expect(calls.findIndex(url => url.includes("/organizations/"))).toBeLessThan(calls.findIndex(url => url.endsWith("/federated-identity")));
  expect(calls.some(url => url.includes("/identity-provider/"))).toBe(false);
});
test("a foreign organization never reaches the realm-global federation endpoint", async () => {
  const { adapter, calls } = client(() => Response.json([]), false);
  await expect(adapter.listFederatedIdentities!("org/acme", "user/one")).rejects.toMatchObject({ status: 404 });
  expect(calls.some(url => url.endsWith("/federated-identity"))).toBe(false);
});
test("only a successful empty response means no linked providers", async () => {
  const empty = client(() => Response.json([]));
  expect(await empty.adapter.listFederatedIdentities!("org/acme", "user/one")).toEqual([]);
  for (const response of [Response.json({ error: "Forbidden" }, { status: 403 }), Response.json({ error: "Unavailable" }, { status: 503 }), Response.json([{ identityProvider: "" }])]) {
    const { adapter } = client(() => response);
    await expect(adapter.listFederatedIdentities!("org/acme", "user/one")).rejects.toBeDefined();
  }
});
test("provider timeouts remain unavailable rather than an empty result", async () => {
  const { adapter } = client(() => { throw new DOMException("Timed out", "TimeoutError"); });
  await expect(adapter.listFederatedIdentities!("org/acme", "user/one")).rejects.toMatchObject({ code: "KEYCLOAK_ADMIN_UNAVAILABLE", operation: "list_member_federated_identities" });
});
