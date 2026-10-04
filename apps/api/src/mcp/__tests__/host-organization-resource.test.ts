// SPDX-License-Identifier: BUSL-1.1
// Requires generated runtime artifacts: standalone `bun run generate`, or
// Hubble `bun run runtime:prepare` and tests from its prepared runtime tree.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { __resetSessionResolverForTests, resolveSessionContext } from "../../auth/identity.js";
import { stubLinkedMembershipForTests } from "../../auth/identity-link.test-support.js";
import { __setTenantForOrganizationForTests } from "../../auth/tenant-resolution.js";
import { createMcpSessionAdmission } from "../session-admission.js";
import { buildAuthenticateChallenge, registerProtectedResourceMetadata } from "../protected-resource-metadata.js";

const ORIGIN = "https://api.example.test";
const ISSUER = "https://identity.example.test/realms/host";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ENV = ["OPENSHAPEFORGE_ORGANIZATION_CONTEXT", "OPENSHAPEFORGE_PUBLIC_ORIGIN",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER", "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE", "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES"] as const;
const saved = new Map(ENV.map(name => [name, process.env[name]]));
let key: KeyObject;
let jwks: ReturnType<typeof Bun.serve>;
let app: FastifyInstance;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  key = pair.privateKey;
  const publicKey = { ...pair.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [publicKey] }) });
});
beforeEach(async () => {
  process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = ORIGIN;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", jwks.url).href;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = "web";
  __resetSessionResolverForTests();
  stubLinkedMembershipForTests();
  __setTenantForOrganizationForTests(async (realm, id) => realm === "host" && id === "org-a" ? TENANT : null);
  app = Fastify();
  registerProtectedResourceMetadata(app);
  const admit = createMcpSessionAdmission({});
  for (const url of ["/:alias", "/:alias/mcp", "/api/mcp"]) {
    app.post(url, async (request, reply) => {
      try { await admit(request); return { admitted: true }; }
      catch (error) {
        const e = error as { status?: number; code?: string; message?: string };
        const status = e.status ?? 500;
        if (status === 401 || status === 403) reply.header("www-authenticate", buildAuthenticateChallenge(request));
        return reply.code(status).send({ code: e.code, message: e.message });
      }
    });
  }
  await app.ready();
});
afterEach(async () => {
  await app.close();
  for (const name of ENV) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  __resetSessionResolverForTests();
});
afterAll(() => jwks.stop(true));

function token(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, aud: [`${ORIGIN}/alpha`], azp: "dynamic-client",
    sub: "33333333-3333-4333-8333-333333333333", iat: now, exp: now + 300,
    scope: "openid organization", organization: { alpha: { id: "org-a" } }, ...overrides };
  const input = [JSON.stringify({ alg: "RS256", kid: "test" }), JSON.stringify(payload)]
    .map(part => Buffer.from(part).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
function post(url: string, bearer?: string) {
  return app.inject({ method: "POST", url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, payload: {} });
}

test.each(["/.well-known/oauth-protected-resource/alpha", "/.well-known/oauth-protected-resource/alpha/mcp"])("host mode publishes organization discovery at %s", async url => {
  const response = await app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  expect(response.json().resource).toBe(`${ORIGIN}/alpha`);
  expect(response.json().scopes_supported).toContain("mcp-resource:alpha");
});
test("shared host discovery retains its canonical resource", async () => {
  const response = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
  expect(response.json().resource).toBe(`${ORIGIN}/api/mcp`);
  expect(response.json().scopes_supported).toEqual(["organization"]);
});
test("organization probe receives its own usable OAuth challenge", async () => {
  const response = await post("/alpha");
  expect(response.statusCode).toBe(401);
  expect(response.headers["www-authenticate"]).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/alpha`);
  expect(response.headers["www-authenticate"]).toContain("mcp-resource:alpha");
});
test.each(["/alpha", "/alpha/mcp"])("signed organization token passes admission on %s", async url => {
  // 503 DATABASE_NOT_CONFIGURED means identity admission succeeded and the
  // route reached its database requirement; no product/tool execution is claimed.
  const response = await post(url, token());
  expect(response.statusCode).toBe(503);
  expect(response.json().code).toBe("DATABASE_NOT_CONFIGURED");
});
test("canonical host audience cannot substitute for organization audience", async () => {
  expect((await post("/alpha", token({ aud: ["api", `${ORIGIN}/api/mcp`] }))).statusCode).toBe(403);
});
test("organization token cannot access another organization's path", async () => {
  expect((await post("/beta", token())).statusCode).toBe(403);
});
test("organization token cannot access the shared resource", async () => {
  expect((await post("/api/mcp", token())).statusCode).toBe(401);
});
test("bound resource selects its registry tenant from multiple memberships", async () => {
  const bearer = token({ organization: { alpha: { id: "org-a" }, beta: { id: "org-b" } } });
  const session = await resolveSessionContext(new Headers({ authorization: `Bearer ${bearer}` }), {
    organization: { alias: "alpha", resource: `${ORIGIN}/alpha` },
  });
  expect(session.tenantId).toBe(TENANT);
  expect(session.credential).toBe("bearer");
  expect((await post("/alpha", bearer)).statusCode).toBe(503);
  expect((await post("/beta", bearer)).statusCode).toBe(403);
});
test("bound resource still rejects a tenant id conflicting with the registry", async () => {
  expect((await post("/alpha", token({ tid: "22222222-2222-4222-8222-222222222222" }))).statusCode).toBe(403);
});
test("reserved root paths do not become organization resources", async () => {
  expect((await post("/admin", token())).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/admin" })).statusCode).toBe(404);
});
