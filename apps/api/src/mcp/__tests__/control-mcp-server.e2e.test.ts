// SPDX-License-Identifier: BUSL-1.1
/**
 * `/api/control/mcp` admission, in-process against the real app with tokens
 * signed by a throwaway key served as a JWKS for the CONTROL realm. No
 * database: a request that passes admission is recognised by the 503 the
 * handler answers when it then reaches for the database — the one answer
 * that is impossible for a refused token (organization-resource.e2e.test.ts
 * uses the same trick for the tenant surface).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { __resetControlVerifiersForTests } from "../../control/authorization.js";
import { PLATFORM_ADMIN_ROLE } from "../../control/platform-admin.js";
import { createApiApp } from "../../roles/api.js";
import { CONTROL_MCP_METADATA_PATH, CONTROL_MCP_PATH } from "../control-mcp-server.js";
import { PROTECTED_RESOURCE_METADATA_PATH } from "../protected-resource-metadata.js";

const CONTROL_ISSUER = "https://keycloak.test/realms/openshapeforge-control";
const TENANT_ISSUER = "https://keycloak.test/realms/openshapeforge";
const HOST = "127.0.0.1:3351";
const ORIGIN = `http://${HOST}`;

const MANAGED_ENV = [
  "OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL",
  "KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API",
  "OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID",
  "OPENSHAPEFORGE_CONTROL_MCP_AUTHORIZED_PARTIES",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
] as const;
const saved = new Map<string, string | undefined>();

let app: ReturnType<typeof createApiApp>;
let controlJwks: ReturnType<typeof Bun.serve>;
let controlKey: KeyObject;
let tenantKey: KeyObject;

function signJwt(key: KeyObject, payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", kid: "test", typ: "JWT" })}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

beforeAll(async () => {
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const control = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tenant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  controlKey = control.privateKey;
  tenantKey = tenant.privateKey;
  const jwk = { ...control.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
  controlJwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL = "https://keycloak.test";
  process.env.KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API = "test-secret";
  process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER = CONTROL_ISSUER;
  process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI = new URL("/certs", controlJwks.url).href;
  process.env.OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID = "openshapeforge-admin-gateway";
  process.env.OPENSHAPEFORGE_CONTROL_MCP_AUTHORIZED_PARTIES = "openshapeforge-admin-gateway,codex-platform";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = TENANT_ISSUER;
  __resetControlVerifiersForTests();
  app = createApiApp({ cors: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  controlJwks?.stop(true);
  for (const key of MANAGED_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetControlVerifiersForTests();
});

function mint(key: KeyObject, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(key, { iat: now, exp: now + 300, ...claims });
}

const adminToken = (overrides: Record<string, unknown> = {}) =>
  mint(controlKey, {
    iss: CONTROL_ISSUER,
    sub: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
    azp: "codex-platform",
    preferred_username: "hubble-platform-admin",
    realm_access: { roles: [PLATFORM_ADMIN_ROLE] },
    ...overrides,
  });

async function call(token?: string, method = "tools/list") {
  return app.inject({
    method: "POST",
    url: CONTROL_MCP_PATH,
    headers: {
      host: HOST,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: { jsonrpc: "2.0", id: 1, method },
  });
}

describe("platform administrator MCP discovery", () => {
  test("publishes its own metadata naming the CONTROL realm as authorization server", async () => {
    const response = await app.inject({ method: "GET", url: CONTROL_MCP_METADATA_PATH, headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.resource).toBe(`${ORIGIN}${CONTROL_MCP_PATH}`);
    expect(body.authorization_servers).toEqual([CONTROL_ISSUER]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(body.scopes_supported).toBeUndefined();
    // ...while the tenant document keeps naming the tenant realm.
    const tenant = await app.inject({ method: "GET", url: PROTECTED_RESOURCE_METADATA_PATH, headers: { host: HOST } });
    expect(JSON.parse(tenant.body).authorization_servers).toEqual([TENANT_ISSUER]);
  });

  test("an unauthenticated request is challenged with the control resource's metadata", async () => {
    const response = await call();
    expect(response.statusCode).toBe(401);
    expect(String(response.headers["www-authenticate"])).toBe(
      `Bearer resource_metadata="${ORIGIN}${CONTROL_MCP_METADATA_PATH}"`,
    );
  });
});

describe("platform administrator MCP admission", () => {
  test("a platform_admin token from the PKCE client is admitted (and only then reaches the database)", async () => {
    const response = await call(adminToken());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe("DATABASE_NOT_CONFIGURED");
  });

  test("a tenant-realm token is refused exactly like no token — nothing to enumerate", async () => {
    const tenantToken = mint(tenantKey, {
      iss: TENANT_ISSUER,
      sub: "user-zerocopter-admin",
      azp: "codex",
      aud: ["hubble-api"],
      organization: { "zerocopter-dev": { id: "8ba94fb8-08d3-4907-9af3-5bd1e2018f46" } },
      resource_access: { "hubble-api": { roles: ["org_admin"] } },
      realm_access: { roles: [PLATFORM_ADMIN_ROLE] },
    });
    const refused = await call(tenantToken);
    const anonymous = await call();
    expect(refused.statusCode).toBe(401);
    expect(JSON.parse(refused.body).error.code).toBe("UNAUTHENTICATED");
    expect(refused.headers["www-authenticate"]).toBe(anonymous.headers["www-authenticate"]);
    const message = JSON.parse(refused.body).error.message as string;
    expect(message).not.toContain("zerocopter");
    expect(message).not.toContain("openshapeforge-control");
    expect(message).not.toContain("issuer");
  });

  test("a control-realm token without platform_admin is 403, the operator role notwithstanding", async () => {
    const response = await call(adminToken({ realm_access: { roles: ["platform-operator"] } }));
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe("FORBIDDEN");
  });

  test("admin-cli and the tenant PKCE client are not admitted parties", async () => {
    for (const azp of ["admin-cli", "codex"]) {
      const response = await call(adminToken({ azp }));
      expect(response.statusCode).toBe(401);
    }
  });

  test("trusted-context headers and an API key are refused without a role check", async () => {
    const trusted = await app.inject({
      method: "POST",
      url: CONTROL_MCP_PATH,
      headers: {
        host: HOST,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-openshapeforge-user-id": "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
        "x-openshapeforge-roles": PLATFORM_ADMIN_ROLE,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(trusted.statusCode).toBe(401);
    const apiKey = await app.inject({
      method: "POST",
      url: CONTROL_MCP_PATH,
      headers: {
        host: HOST,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: "ApiKey osf_live_not_a_bearer",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(apiKey.statusCode).toBe(401);
  });
});
