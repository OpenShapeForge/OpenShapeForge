// SPDX-License-Identifier: BUSL-1.1
/**
 * `/<alias>` (organization MCP resource) admission, in-process against the real app
 * with tokens signed by a throwaway key served as a JWKS. No database: the
 * registry read is stubbed, and a request that passes admission is recognised
 * by the 503 the handler answers when it then reaches for the database — the
 * one answer that is impossible for a refused token.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { __resetSessionResolverForTests } from "../../auth/identity.js";
import { __setTenantForOrganizationForTests } from "../../auth/tenant-resolution.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { createApiApp } from "../../roles/api.js";
import { MCP_MOUNT_PATH } from "../generated-mcp-server.js";
import { PROTECTED_RESOURCE_METADATA_PATH } from "../protected-resource-metadata.js";

const ISSUER = "https://keycloak.test/realms/openshapeforge";
const HOST = "127.0.0.1:3161";
const ORIGIN = `http://${HOST}`;
const ACME_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXAMPLE_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACME_TENANT = "33333333-3333-4333-8333-333333333333";
const EXAMPLE_TENANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MANAGED_ENV = [
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES",
  "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET",
  "OPENSHAPEFORGE_PUBLIC_ORIGIN",
] as const;
const saved = new Map<string, string | undefined>();

let app: ReturnType<typeof createApiApp>;
let jwks: ReturnType<typeof Bun.serve>;
let privateKey: KeyObject;

/** RS256 without a JWT library: header.payload signed with PKCS#1 v1.5 SHA-256. */
function signJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", kid: "test", typ: "JWT" })}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

beforeAll(async () => {
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/certs", jwks.url).href;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "example-api";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = "codex";
  __resetSessionResolverForTests();
  __setTenantForOrganizationForTests(async (realm, organizationId) => {
    if (realm !== "openshapeforge") return null;
    if (organizationId === ACME_ORG) return ACME_TENANT;
    if (organizationId === EXAMPLE_ORG) return EXAMPLE_TENANT;
    return null;
  });
  app = createApiApp({ cors: false, modules: await loadRuntimeModules() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  jwks?.stop(true);
  for (const key of MANAGED_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetSessionResolverForTests();
});

beforeEach(() => {
  // The tenant lookup seam is cleared by the reset; keep it for every test.
  __setTenantForOrganizationForTests(async (realm, organizationId) => {
    if (realm !== "openshapeforge") return null;
    if (organizationId === ACME_ORG) return ACME_TENANT;
    if (organizationId === EXAMPLE_ORG) return EXAMPLE_TENANT;
    return null;
  });
});

type TokenShape = {
  sub?: string;
  aud: string[];
  organization?: Record<string, { id: string }>;
  scope?: string;
  tid?: string;
};

async function mint(shape: TokenShape): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: ISSUER,
    sub: shape.sub ?? "user-acme-admin",
    iat: now,
    exp: now + 300,
    aud: shape.aud,
    azp: "codex",
    scope: shape.scope ?? "openid",
    ...(shape.organization ? { organization: shape.organization } : {}),
    ...(shape.tid ? { tid: shape.tid } : {}),
    resource_access: { "example-api": { roles: ["Advies.All.Read"] } },
  });
}

// The resource NAME is the short address (`https://host/<alias>`), whichever
// spelling the request used to reach it — that is the whole point of one
// canonical URI, and it is what `aud` has to hold.
const resource = (alias: string) => `${ORIGIN}/${alias}`;

/** As Keycloak mints it for `openid organization:<alias> mcp-resource:<alias>`. */
async function boundToken(alias: string, organizationId: string, sub?: string) {
  return mint({
    ...(sub ? { sub } : {}),
    aud: ["example-api", resource(alias), "account"],
    organization: { [alias]: { id: organizationId } },
    scope: `openid organization:${alias} mcp-resource:${alias}`,
  });
}

async function call(path: string, token?: string, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      host: HOST,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
}

describe("per-organization MCP resource admission", () => {
  test("an unauthenticated request is challenged with the per-path metadata and its scopes", async () => {
    const response = await call("/acme-dev");
    expect(response.statusCode).toBe(401);
    const challenge = String(response.headers["www-authenticate"]);
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}/acme-dev"`,
    );
    expect(challenge).toContain('scope="organization mcp-resource:acme-dev"');
    expect(challenge).not.toContain("insufficient_scope");
  });

  test("a bound Acme token is admitted on Acme's resource (and only then needs the database)", async () => {
    const token = await boundToken("acme-dev", ACME_ORG);
    const response = await call("/acme-dev", token);
    // Bound, and then refused as a person no membership record can be read
    // for: this app has no database, and a person is never admitted from the
    // token alone (503, not a session).
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe("AUTHENTICATION_UNAVAILABLE");
  });

  test("the same Acme token on Example's resource is refused like an unknown alias", async () => {
    const token = await boundToken("acme-dev", ACME_ORG);
    const onExample = await call("/example", token);
    const onUnknown = await call("/no-such-org", token);
    expect(onExample.statusCode).toBe(403);
    expect(onUnknown.statusCode).toBe(403);
    const exampleBody = JSON.parse(onExample.body);
    const unknownBody = JSON.parse(onUnknown.body);
    expect(exampleBody.error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(unknownBody.error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(exampleBody.error.message.replaceAll("example", "X")).toBe(
      unknownBody.error.message.replaceAll("no-such-org", "X"),
    );
    const challenge = String(onExample.headers["www-authenticate"]);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="organization mcp-resource:example"');
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}/example"`,
    );
  });

  test("a member's token that was not requested for the resource says which scopes to request", async () => {
    // Legacy-shaped token: membership present, no per-resource audience.
    const token = await mint({
      aud: ["example-api", "account"],
      organization: { "acme-dev": { id: ACME_ORG } },
      scope: "openid",
    });
    const response = await call("/acme-dev", token);
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(body.error.message).toContain("`organization`");
    expect(body.error.message).toContain("`mcp-resource:acme-dev`");
    expect(body.error.message).toContain(resource("acme-dev"));
    // ...and the legacy mount still takes it (tenant from the membership).
    const legacy = await call(MCP_MOUNT_PATH, token);
    expect(legacy.statusCode).toBe(503);
    expect(JSON.parse(legacy.body).error.code).toBe("AUTHENTICATION_UNAVAILABLE");
  });

  test("the audience Keycloak mints for a non-member is not admission", async () => {
    const token = await mint({
      aud: ["example-api", resource("example")],
      organization: { "acme-dev": { id: ACME_ORG } },
      scope: "openid mcp-resource:example",
    });
    const response = await call("/example", token);
    expect(response.statusCode).toBe(403);
  });

  test("a token for the same alias on another origin is refused (audience is the exact resource URL)", async () => {
    const token = await mint({
      aud: ["example-api", "http://127.0.0.1:3121/acme-dev"],
      organization: { "acme-dev": { id: ACME_ORG } },
      scope: "openid organization:acme-dev mcp-resource:acme-dev",
    });
    const response = await call("/acme-dev", token);
    expect(response.statusCode).toBe(403);
  });

  test("a bound token whose organization no tenant links to is refused the same way", async () => {
    const token = await mint({
      aud: ["example-api", resource("orphan")],
      organization: { orphan: { id: "00000000-0000-4000-8000-000000000000" } },
      scope: "openid organization:orphan mcp-resource:orphan",
    });
    const response = await call("/orphan", token);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
  });

  test("a malformed alias is not a resource", async () => {
    const token = await boundToken("acme-dev", ACME_ORG);
    const response = await call("/-not-an-alias", token);
    expect(response.statusCode).toBe(404);
  });

  test("trusted-context headers cannot pick a tenant by path", async () => {
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = "organization-resource-test-secret";
    __resetSessionResolverForTests();
    try {
      const { applyTrustedContextHeaders } = await import("@openshapeforge/auth");
      const headers = new Headers();
      applyTrustedContextHeaders(
        headers,
        { tenantId: EXAMPLE_TENANT, userId: "user-example-admin", roles: ["Advies.All.Read"] },
        { secret: "organization-resource-test-secret" },
      );
      const response = await call(
        "/example",
        undefined,
        Object.fromEntries(headers.entries()),
      );
      expect(response.statusCode).toBe(401);
    } finally {
      delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
      __resetSessionResolverForTests();
    }
  });
});

describe("per-organization protected resource metadata", () => {
  test("names the exact resource and the scopes to request", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${PROTECTED_RESOURCE_METADATA_PATH}/example`,
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.resource).toBe(resource("example"));
    expect(body.scopes_supported).toEqual(["organization", "mcp-resource:example"]);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  test("the legacy documents advertise no scopes and the legacy resource", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_MOUNT_PATH}`,
      headers: { host: HOST },
    });
    const body = JSON.parse(response.body);
    expect(body.resource).toBe(`${ORIGIN}${MCP_MOUNT_PATH}`);
    expect(body.scopes_supported).toBeUndefined();
  });

  test("a malformed alias has no document", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${PROTECTED_RESOURCE_METADATA_PATH}/-nope`,
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(404);
  });
});
