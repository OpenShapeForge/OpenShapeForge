// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { KeycloakAdmin } from "./keycloak-admin.js";
import { stubRealm } from "./__tests__/fixtures.js";

test("a legacy client gains its explicit audience before its last role is withdrawn, idempotently", async () => {
  const realm = stubRealm();
  try {
    const config = { baseUrl: realm.baseUrl, realm: realm.realm, clientId: "provisioner", clientSecret: "synthetic" };
    const legacy = await new KeycloakAdmin(config).createServiceAccountClient("osf-int-legacy", "Legacy");
    const admin = new KeycloakAdmin({ ...config, apiAudience: "api-verifier" });
    await admin.ensureApiAudience(legacy.clientId);
    await admin.ensureApiAudience(legacy.clientId);
    expect(realm.requests.filter((r) => r.startsWith("POST ") && r.endsWith("/protocol-mappers/models"))).toHaveLength(1);
    const response = await fetch(`${realm.baseUrl}/admin/realms/${realm.realm}/clients/${legacy.internalId}/protocol-mappers/models`);
    expect(await response.json()).toContainEqual(expect.objectContaining({
      protocol: "openid-connect", protocolMapper: "oidc-audience-mapper",
      config: expect.objectContaining({ "included.custom.audience": "api-verifier", "access.token.claim": "true" }),
    }));
  } finally { await realm.stop(); }
});

test("an audience mapper name conflict is refused rather than silently losing the audience", async () => {
  const realm = stubRealm({ onAdminRequest: async (method, path) => {
    if (method === "POST" && path.endsWith("/protocol-mappers/models")) return new Response(null, { status: 409 });
  } });
  try {
    const config = { baseUrl: realm.baseUrl, realm: realm.realm, clientId: "provisioner", clientSecret: "synthetic" };
    const legacy = await new KeycloakAdmin(config).createServiceAccountClient("osf-int-legacy", "Legacy");
    await expect(new KeycloakAdmin({ ...config, apiAudience: "api-verifier" }).ensureApiAudience(legacy.clientId))
      .rejects.toMatchObject({ status: 409 });
  } finally { await realm.stop(); }
});
