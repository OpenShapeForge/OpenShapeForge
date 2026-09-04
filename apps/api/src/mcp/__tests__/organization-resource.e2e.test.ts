// SPDX-License-Identifier: BUSL-1.1
/**
 * `/api/mcp/organizations/<alias>` admission, in-process against the real app
 * with tokens signed by a throwaway key served as a JWKS. No database: the
 * registry read is stubbed, and a request that passes admission is recognised
 * by the 503 the handler answers when it then reaches for the database — the
 * one answer that is impossible for a refused token.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  __resetSessionResolverForTests,
  __setTenantForOrganizationForTests,
} from "../../auth/identity.js";
import { createApiApp } from "../../roles/api.js";
import { MCP_MOUNT_PATH } from "../generated-mcp-server.js";
import { PROTECTED_RESOURCE_METADATA_PATH } from "../protected-resource-metadata.js";

const ISSUER = "https://keycloak.test/realms/openshapeforge";
const HOST = "127.0.0.1:3161";
const ORIGIN = `http://${HOST}`;
const ZEROCOPTER_ORG = "8ba94fb8-08d3-4907-9af3-5bd1e2018f46";
const HUBBLE_ORG = "2e45b405-2acc-4199-b1e3-9a9dc1236ec3";
const ZEROCOPTER_TENANT = "33333333-3333-4333-8333-333333333333";
const HUBBLE_TENANT = "292a5b94-76f4-43f2-82cd-df09656e912f";

const MANAGED_ENV = [
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES",
  "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET",
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
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "hubble-api";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = "codex";
  __resetSessionResolverForTests();
  __setTenantForOrganizationForTests(async (realm, organizationId) => {
    if (realm !== "openshapeforge") return null;
    if (organizationId === ZEROCOPTER_ORG) return ZEROCOPTER_TENANT;
    if (organizationId === HUBBLE_ORG) return HUBBLE_TENANT;
    return null;
  });
  app = createApiApp({ cors: false });
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
    if (organizationId === ZEROCOPTER_ORG) return ZEROCOPTER_TENANT;
    if (organizationId === HUBBLE_ORG) return HUBBLE_TENANT;
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
    sub: shape.sub ?? "user-zerocopter-admin",
    iat: now,
    exp: now + 300,
    aud: shape.aud,
    azp: "codex",
    scope: shape.scope ?? "openid",
    ...(shape.organization ? { organization: shape.organization } : {}),
    ...(shape.tid ? { tid: shape.tid } : {}),
    resource_access: { "hubble-api": { roles: ["Pentest.All.Read"] } },
  });
}

const resource = (alias: string) => `${ORIGIN}/api/mcp/organizations/${alias}`;

/** As Keycloak mints it for `openid organization:<alias> mcp-resource:<alias>`. */
async function boundToken(alias: string, organizationId: string, sub?: string) {
  return mint({
    ...(sub ? { sub } : {}),
    aud: ["hubble-api", resource(alias), "account"],
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
    const response = await call("/api/mcp/organizations/zerocopter-dev");
    expect(response.statusCode).toBe(401);
    const challenge = String(response.headers["www-authenticate"]);
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}/api/mcp/organizations/zerocopter-dev"`,
    );
    expect(challenge).toContain('scope="organization:zerocopter-dev mcp-resource:zerocopter-dev"');
    expect(challenge).not.toContain("insufficient_scope");
  });

  test("a bound Zerocopter token is admitted on Zerocopter's resource (and only then reaches the database)", async () => {
    const token = await boundToken("zerocopter-dev", ZEROCOPTER_ORG);
    const response = await call("/api/mcp/organizations/zerocopter-dev", token);
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe("DATABASE_NOT_CONFIGURED");
  });

  test("the same Zerocopter token on Hubble's resource is refused like an unknown alias", async () => {
    const token = await boundToken("zerocopter-dev", ZEROCOPTER_ORG);
    const onHubble = await call("/api/mcp/organizations/hubble", token);
    const onUnknown = await call("/api/mcp/organizations/no-such-org", token);
    expect(onHubble.statusCode).toBe(403);
    expect(onUnknown.statusCode).toBe(403);
    const hubbleBody = JSON.parse(onHubble.body);
    const unknownBody = JSON.parse(onUnknown.body);
    expect(hubbleBody.error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(unknownBody.error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(hubbleBody.error.message.replaceAll("hubble", "X")).toBe(
      unknownBody.error.message.replaceAll("no-such-org", "X"),
    );
    const challenge = String(onHubble.headers["www-authenticate"]);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="organization:hubble mcp-resource:hubble"');
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}/api/mcp/organizations/hubble"`,
    );
  });

  test("a member's token that was not requested for the resource says which scopes to request", async () => {
    // Legacy-shaped token: membership present, no per-resource audience.
    const token = await mint({
      aud: ["hubble-api", "account"],
      organization: { "zerocopter-dev": { id: ZEROCOPTER_ORG } },
      scope: "openid",
    });
    const response = await call("/api/mcp/organizations/zerocopter-dev", token);
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
    expect(body.error.message).toContain("`organization:zerocopter-dev`");
    expect(body.error.message).toContain("`mcp-resource:zerocopter-dev`");
    expect(body.error.message).toContain(resource("zerocopter-dev"));
    // ...and the legacy mount still takes it (tenant from the membership).
    const legacy = await call(MCP_MOUNT_PATH, token);
    expect(legacy.statusCode).toBe(503);
    expect(JSON.parse(legacy.body).error.code).toBe("DATABASE_NOT_CONFIGURED");
  });

  test("the audience Keycloak mints for a non-member is not admission", async () => {
    const token = await mint({
      aud: ["hubble-api", resource("hubble")],
      organization: { "zerocopter-dev": { id: ZEROCOPTER_ORG } },
      scope: "openid mcp-resource:hubble",
    });
    const response = await call("/api/mcp/organizations/hubble", token);
    expect(response.statusCode).toBe(403);
  });

  test("a token for the same alias on another origin is refused (audience is the exact resource URL)", async () => {
    const token = await mint({
      aud: ["hubble-api", "http://127.0.0.1:3121/api/mcp/organizations/zerocopter-dev"],
      organization: { "zerocopter-dev": { id: ZEROCOPTER_ORG } },
      scope: "openid organization:zerocopter-dev mcp-resource:zerocopter-dev",
    });
    const response = await call("/api/mcp/organizations/zerocopter-dev", token);
    expect(response.statusCode).toBe(403);
  });

  test("a bound token whose organization no tenant links to is refused the same way", async () => {
    const token = await mint({
      aud: ["hubble-api", resource("orphan")],
      organization: { orphan: { id: "00000000-0000-4000-8000-000000000000" } },
      scope: "openid organization:orphan mcp-resource:orphan",
    });
    const response = await call("/api/mcp/organizations/orphan", token);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");
  });

  test("a malformed alias is not a resource", async () => {
    const token = await boundToken("zerocopter-dev", ZEROCOPTER_ORG);
    const response = await call("/api/mcp/organizations/-not-an-alias", token);
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
        { tenantId: HUBBLE_TENANT, userId: "user-hubble-admin", roles: ["Pentest.All.Read"] },
        { secret: "organization-resource-test-secret" },
      );
      const response = await call(
        "/api/mcp/organizations/hubble",
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
      url: `${PROTECTED_RESOURCE_METADATA_PATH}/api/mcp/organizations/hubble`,
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.resource).toBe(resource("hubble"));
    expect(body.scopes_supported).toEqual(["organization:hubble", "mcp-resource:hubble"]);
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
      url: `${PROTECTED_RESOURCE_METADATA_PATH}/api/mcp/organizations/-nope`,
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(404);
  });
});
