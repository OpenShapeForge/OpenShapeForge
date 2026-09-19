// SPDX-License-Identifier: BUSL-1.1
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { __resetSessionResolverForTests, __setTenantForOrganizationForTests, resolveSessionContext } from "./identity.js";
import { stubLinkedMembershipForTests } from "./identity-link.test-support.js";

const issuer = "https://identity.example.test/realms/example";
const resource = "https://api.example.test/alpha";
const tenant = "11111111-1111-4111-8111-111111111111";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const names = ["OPENSHAPEFORGE_ORGANIZATION_CONTEXT", "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI", "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES"];
const saved = new Map(names.map(name => [name, process.env[name]]));
let server: ReturnType<typeof Bun.serve>;
const binding = { organization: { alias: "alpha", resource } };

function headers(overrides: Record<string, unknown> = {}) {
  const payload = { iss: issuer, aud: resource, azp: "new-dynamic-client", sub: "person",
    organization: { alpha: { id: "organization-a" } }, scope: "openid organization",
    exp: Math.floor(Date.now() / 1000) + 300, ...overrides };
  const body = [JSON.stringify({ alg: "RS256", kid: "test" }), JSON.stringify(payload)]
    .map(value => Buffer.from(value).toString("base64url")).join(".");
  return new Headers({ authorization: `Bearer ${body}.${sign("RSA-SHA256", Buffer.from(body), keys.privateKey).toString("base64url")}` });
}

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [
    { ...keys.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" },
  ] }) });
});
beforeEach(() => {
  delete process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = issuer;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = `${server.url}jwks`;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "web-api";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = "web";
  __resetSessionResolverForTests();
  stubLinkedMembershipForTests();
  __setTenantForOrganizationForTests(async (realm, organization) =>
    realm === "example" && organization === "organization-a" ? tenant : null);
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  __resetSessionResolverForTests();
});
afterAll(() => server.stop(true));

test("a new dynamic client uses the bound resource audience, not the web client policy", async () => {
  const session = await resolveSessionContext(headers(), binding);
  expect(session.tenantId).toBe(tenant);
  expect(session.credential).toBe("bearer");
  expect((await resolveSessionContext(headers({ aud: "web-api" }))).credential).toBe("none");
});
test("ordinary API audience validation remains active after a resource request", async () => {
  await resolveSessionContext(headers(), binding);
  expect((await resolveSessionContext(headers({ azp: "web" }))).credential).toBe("none");
});
test.each([
  ["wrong audience", { aud: "https://api.example.test/beta" }],
  ["missing membership", { organization: {} }],
  ["unregistered organization", { organization: { alpha: { id: "unknown" } } }],
  ["conflicting tenant", { tid: "22222222-2222-4222-8222-222222222222" }],
])("rejects %s", async (_label, claims) => {
  await expect(resolveSessionContext(headers(claims), binding)).rejects.toHaveProperty("code", "ORGANIZATION_RESOURCE_FORBIDDEN");
});
test.each([
  ["wrong issuer", { iss: "https://other.example.test/realms/example" }],
  ["expired token", { exp: 1 }],
  ["missing client", { azp: undefined }],
])("refuses %s without a session", async (_label, claims) => {
  expect((await resolveSessionContext(headers(claims), binding)).credential).toBe("none");
});
