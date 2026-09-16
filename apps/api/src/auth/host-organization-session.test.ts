// SPDX-License-Identifier: BUSL-1.1
// Run in its own process: OPENSHAPEFORGE_ORGANIZATION_CONTEXT=host bun test ./apps/api/src/auth/host-organization-session.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import Fastify from "fastify";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type QueryResult } from "kysely";
import type { DB } from "../generated/db/types.js";
import type { RuntimeModule } from "../modules/contract.js";
import { ModulePlatformRuntime } from "../modules/platform.js";
import { createControlRuntime } from "../control/runtime.js";
import {
  registerRuntimeOperationRestRoutes,
  runtimeStaticOperationRegistrations,
  type OperationContract,
} from "../operations/runtime.js";
import { mintApiKey } from "./api-key/format.js";
import { __resetExchangeCacheForTests } from "./api-key/exchange.js";
import { encryptSecret, keyringFromEnv } from "../platform/secrets.js";
import {
  __resetSessionResolverForTests, __setTenantForOrganizationForTests, resolveSessionContext,
} from "./identity.js";

const ISSUER = "https://identity.example.test/realms/host";
const RESOURCE = "https://api.example.test/api/mcp";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const ENV = ["OPENSHAPEFORGE_ORGANIZATION_CONTEXT", "OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER", "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE", "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES",
  "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET", "OPENSHAPEFORGE_API_KEY_SECRET_KEYS"] as const;
const saved = new Map(ENV.map((name) => [name, process.env[name]]));
let keys: { publicKey: KeyObject; privateKey: KeyObject };
let server: ReturnType<typeof Bun.serve>;
const lookups: string[][] = [];
let exchangeToken = "";
let exchangeCalls = 0;

async function headers(overrides: Record<string, unknown> = {}): Promise<Headers> {
  const payload = {
    iss: ISSUER, aud: ["api", RESOURCE], sub: USER, azp: "web",
    scope: "openid organization", organization: { alpha: { id: "org-a" } },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
  const input = [JSON.stringify({ alg: "RS256", kid: "test-key" }), JSON.stringify(payload)]
    .map((part) => Buffer.from(part).toString("base64url")).join(".");
  const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  return new Headers({ authorization: `Bearer ${token}` });
}

beforeAll(async () => {
  keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" };
  server = Bun.serve({ port: 0, fetch: (request) => {
    if (new URL(request.url).pathname.endsWith("/token")) {
      exchangeCalls++;
      return Response.json({ access_token: exchangeToken, expires_in: 300 });
    }
    return Response.json({ keys: [publicKey] });
  } });
});
beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", server.url).href;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
  __resetSessionResolverForTests();
  __resetExchangeCacheForTests();
  exchangeCalls = 0;
  lookups.length = 0;
  __setTenantForOrganizationForTests(async (realm, organization) => {
    lookups.push([realm, organization]);
    return realm === "host" ? ({ "org-a": TENANT_A, "org-b": TENANT_B }[organization] ?? null) : null;
  });
});
afterEach(() => {
  for (const name of ENV) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  __resetSessionResolverForTests();
  __resetExchangeCacheForTests();
});
afterAll(() => server.stop(true));

describe("host organization binding through real bearer verification and resolveSessionContext", () => {
  test("binds shared sessions by the selected organization id and issuer realm", async () => {
    const session = await resolveSessionContext(await headers());
    expect(session.tenantId).toBe(TENANT_A);
    expect(session.credential).toBe("bearer");
    expect(lookups).toEqual([["host", "org-a"]]);
  });

  test.each([
    ["missing", undefined], ["empty", {}], ["legacy array", [TENANT_A]],
    ["missing id", { alpha: {} }], ["blank id", { alpha: { id: " " } }],
    ["multiple", { alpha: { id: "org-a" }, beta: { id: "org-b" } }],
    ["partially malformed", { alpha: { id: "org-a" }, beta: null }],
    ["unknown membership", { alpha: { id: "not-provisioned" } }],
  ])("rejects %s membership even with tid", async (_label, organization) => {
    const session = await resolveSessionContext(await headers({ organization, tid: TENANT_A }));
    expect(session.credential).toBe("none");
    expect(session.tenantId).toBeNull();
  });

  test("an alias-specific scope cannot disambiguate multiple memberships", async () => {
    const session = await resolveSessionContext(await headers({
      organization: { alpha: { id: "org-a" }, beta: { id: "org-b" } },
      scope: "organization organization:alpha",
    }));
    expect(session.credential).toBe("none");
    expect(lookups).toHaveLength(0);
  });

  test.each(["openid", "organization:alpha", "organization:*"])("requires generic scope, rejects %s", async (scope) => {
    expect((await resolveSessionContext(await headers({ scope }))).credential).toBe("none");
  });

  test("tid must match the registry; malformed tid is also refused", async () => {
    expect((await resolveSessionContext(await headers({ tid: TENANT_A }))).tenantId).toBe(TENANT_A);
    for (const tid of [TENANT_B, [TENANT_A], null, ""]) {
      expect((await resolveSessionContext(await headers({ tid }))).credential).toBe("none");
    }
  });

  test("another issuer is rejected before lookup, and another registry realm cannot match", async () => {
    expect((await resolveSessionContext(await headers({ iss: "https://identity.example.test/realms/other" }))).credential).toBe("none");
    expect(lookups).toHaveLength(0);
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://identity.example.test/realms/other";
    __resetSessionResolverForTests();
    __setTenantForOrganizationForTests(async (realm, id) => realm === "host" && id === "org-a" ? TENANT_A : null);
    expect((await resolveSessionContext(await headers({ iss: process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER }))).credential).toBe("none");
  });

  test("no database or registry proof fails closed", async () => {
    __setTenantForOrganizationForTests(null);
    expect((await resolveSessionContext(await headers())).credential).toBe("none");
  });

  test("resource audience grants neither membership nor a missing subject", async () => {
    for (const claims of [{ organization: undefined }, { sub: undefined }]) {
      expect((await resolveSessionContext(await headers(claims), { requiredAudience: RESOURCE })).credential).toBe("none");
    }
  });

  test("tampering with the selected organization invalidates the signature", async () => {
    const request = await headers();
    const parts = request.get("authorization")!.slice("Bearer ".length).split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    payload.organization = { beta: { id: "org-b" } };
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    request.set("authorization", `Bearer ${parts.join(".")}`);
    expect((await resolveSessionContext(request)).credential).toBe("none");
    expect(lookups).toHaveLength(0);
  });

  test("organization selection is independent for fresh tokens sharing subject and login session", async () => {
    const a = await headers({ sid: "same-login", jti: "first-token" });
    const b = await headers({ sid: "same-login", jti: "refreshed-token", organization: { beta: { id: "org-b" } } });
    expect((await resolveSessionContext(a)).tenantId).toBe(TENANT_A);
    expect((await resolveSessionContext(b)).tenantId).toBe(TENANT_B);
    expect((await resolveSessionContext(a)).tenantId).toBe(TENANT_A);
    expect((await resolveSessionContext(await headers({ sid: "same-login", organization: {} }))).credential).toBe("none");
  });

  test("mode is read after import; off preserves legacy tid preference", async () => {
    const request = await headers({ organization: undefined, tid: TENANT_A });
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "off";
    expect((await resolveSessionContext(request)).tenantId).toBe(TENANT_A);
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
    expect((await resolveSessionContext(request)).credential).toBe("none");
  });

  test("raw tenant or selection headers cannot choose the organization", async () => {
    const request = await headers();
    request.set("x-tenant-id", TENANT_B);
    request.set("x-organization-id", "org-b");
    expect((await resolveSessionContext(request)).tenantId).toBe(TENANT_A);
  });

  test("host roles exclude sibling clients and never flatten organization-local grants", async () => {
    const request = await headers({
      realm_access: { roles: ["realm-reader"] },
      resource_access: { api: { roles: ["Records.Read"] }, sibling: { roles: ["Records.Admin"] } },
      organization: { alpha: { id: "org-a", realm_access: { roles: ["nested-admin"] } } },
    });
    expect((await resolveSessionContext(request)).roles).toEqual(["Records.Read", "realm-reader"]);
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "off";
    expect((await resolveSessionContext(request)).roles).toEqual(["Records.Admin", "Records.Read", "realm-reader"]);
  });

  test("strict mode refuses signed trusted context, including with an invalid bearer", async () => {
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = "synthetic-context-secret";
    const request = new Headers();
    applyTrustedContextHeaders(request, { tenantId: TENANT_B, userId: USER, roles: [] }, { secret: "synthetic-context-secret" });
    expect((await resolveSessionContext(request)).credential).toBe("none");
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "off";
    expect((await resolveSessionContext(request)).tenantId).toBe(TENANT_B);
    expect((await resolveSessionContext(request, { requiredAudience: RESOURCE })).credential).toBe("none");
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
    request.set("authorization", "Bearer invalid");
    expect((await resolveSessionContext(request)).credential).toBe("none");
  });

  test.each(["api", "admin", ["api", "admin"], ["api", `${RESOURCE}/`], ["api", `${RESOURCE}?tenant=alpha`]].map((aud) => ({ aud })))(
    "resource audience rejects exact-match failure %j", async ({ aud }) => {
      expect((await resolveSessionContext(await headers({ aud }), { requiredAudience: RESOURCE })).credential).toBe("none");
      expect(lookups).toHaveLength(0);
    },
  );

  test("resource audience accepts arrays and scalar aud, in addition to verifier audience", async () => {
    expect((await resolveSessionContext(await headers(), { requiredAudience: RESOURCE })).tenantId).toBe(TENANT_A);
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = RESOURCE;
    __resetSessionResolverForTests();
    __setTenantForOrganizationForTests(async () => TENANT_A);
    expect((await resolveSessionContext(await headers({ aud: RESOURCE }), { requiredAudience: RESOURCE })).tenantId).toBe(TENANT_A);
    expect((await resolveSessionContext(await headers({ aud: "api" }), { requiredAudience: "api" })).credential).toBe("none");
  });

  test("dynamic client azp is accepted only in host mode with a verified required resource audience", async () => {
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = "web";
    __resetSessionResolverForTests();
    __setTenantForOrganizationForTests(async () => TENANT_A);
    const dynamic = await headers({ azp: "dynamically-registered-client" });
    expect((await resolveSessionContext(dynamic, { requiredAudience: RESOURCE })).tenantId).toBe(TENANT_A);
    // Using the resource verifier first cannot change the cached generic verifier policy.
    expect((await resolveSessionContext(dynamic)).credential).toBe("none");
    expect((await resolveSessionContext(await headers())).tenantId).toBe(TENANT_A);
    for (const claims of [
      { azp: "dynamic", aud: "api" },
      { azp: "dynamic", aud: ["api", "admin"] },
      { azp: "dynamic", aud: RESOURCE }, // Still needs configured API audience.
      { azp: "dynamic", iss: "https://identity.example.test/realms/other" },
      { azp: undefined },
    ]) {
      expect((await resolveSessionContext(await headers(claims), { requiredAudience: RESOURCE })).credential).toBe("none");
    }
    process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "off";
    expect((await resolveSessionContext(dynamic, { requiredAudience: RESOURCE })).credential).toBe("none");
  });

  test("required audience rejects API keys before key configuration or database access", async () => {
    expect((await resolveSessionContext(new Headers({ authorization: `Bearer ${mintApiKey().token}` }), {
      requiredAudience: RESOURCE, failOnUnavailable: true,
    })).credential).toBe("none");
  });
});

/** Real Kysely compilation/transactions with a narrow fake registry connection.
 * JWT signature, issuer, audience and session resolution are never mocked.
 */
function serviceRegistry(realm = "host", organizationId: string | null = "org-a", credentialRows?: (query: CompiledQuery) => unknown[] | undefined) {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      const rows = credentialRows?.(query) ?? (query.sql.includes("from platform.tenants")
        ? [{ keycloak_realm: realm, keycloak_organization_id: organizationId }] : []);
      return { rows: rows as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("Unexpected stream"); },
  };
  const db = new Kysely<DB>({ dialect: {
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createDriver: () => ({
      async init() {}, async acquireConnection() { return connection; },
      async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
      async releaseConnection() {}, async destroy() {},
    }),
  } });
  return { db, queries };
}

describe("explicit service credentials in host mode", () => {
  const clientId = "scoped-worker";
  const serviceClaims = { organization: undefined, tid: TENANT_A, azp: clientId, preferred_username: `service-account-${clientId}` };
  beforeEach(() => {
    process.env.OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES = JSON.stringify([
      { tenantId: TENANT_A, clientId, clientSecret: "synthetic-worker-secret" },
    ]);
  });

  test("accepts explicit service credentials only after tenant-scoped realm and organization registry checks", async () => {
    const { db, queries } = serviceRegistry();
    const session = await resolveSessionContext(await headers(serviceClaims), { db });
    expect(session.tenantId).toBe(TENANT_A);
    expect(session.relation).toBeNull();
    expect(lookups).toEqual([["host", "org-a"]]);
    expect(queries.some((q) => q.sql.includes("set_config('app.tenant_id'") && q.parameters.includes(TENANT_A))).toBe(true);
    expect(queries.some((q) => q.sql.includes("from platform.tenants") && q.parameters.includes(TENANT_A))).toBe(true);
    expect(queries.some((q) => q.sql.includes("bypass_rls"))).toBe(false);
    await db.destroy();
  });

  test("shared runtime routes fall back from control to tenant authentication for a same-issuer token", async () => {
    const { db } = serviceRegistry();
    const operation: OperationContract = {
      key: "records.list",
      plugin: "records",
      title: "List records",
      description: "Lists tenant records.",
      handler: "listRecords",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
      errors: [],
      auth: { mode: "session", roles: ["Records.Read"] },
      tenancy: { mode: "required" },
      idempotency: { mode: "none" },
      transports: {
        rest: { method: "GET", path: "/api/records", response: { status: 200, kind: "json" } },
        mcp: { enabled: false, reason: "REST discovery test." },
        graphql: { enabled: false, reason: "REST discovery test." },
        typescript: { enabled: false, reason: "REST discovery test." },
      },
    };
    const module: RuntimeModule = {
      name: "records",
      operationHandlers: { listRecords: async () => ({ value: { records: [] } }) },
    };
    const platform = new ModulePlatformRuntime(db);
    platform.registerStaticOperations(runtimeStaticOperationRegistrations(
      [module],
      { db, platform: platform.services },
      [operation],
    ));
    const control = createControlRuntime({
      config: {
        ok: true,
        config: {
          keycloak: { baseUrl: "https://identity.example.test", tenantRealm: "host", clientId: "auth-api", clientSecret: "test-only" },
          operator: { issuer: ISSUER, jwksUri: new URL("/jwks", server.url).href, clientId: "admin-web" },
          mcpResource: { origins: ["https://api.example.test"], clients: [] },
        },
      },
      operations: [],
    });
    const app = Fastify();
    registerRuntimeOperationRestRoutes(app, { db, platform: platform.services, control });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/operations/${operation.key}`,
        headers: Object.fromEntries(await headers({
          ...serviceClaims,
          resource_access: { api: { roles: ["Records.Read"] } },
        })),
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { id: string }).id).toBe(operation.key);

      // Outside host mode an issuer match identifies a control credential;
      // its control-role refusal must not be retried as a tenant session.
      process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "off";
      const separateRealmResponse = await app.inject({
        method: "GET",
        url: `/api/operations/${operation.key}`,
        headers: Object.fromEntries(await headers({
          organization: undefined,
          tid: TENANT_A,
          resource_access: { api: { roles: ["Records.Read"] } },
        })),
      });
      expect(separateRealmResponse.statusCode).toBe(401);
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  test("rejects missing registry, cross-realm registry, missing organization, conflicting tid and unconfigured accounts", async () => {
    expect((await resolveSessionContext(await headers(serviceClaims))).credential).toBe("none");
    for (const fixture of [serviceRegistry("other"), serviceRegistry("host", null), serviceRegistry("host", "org-b")]) {
      expect((await resolveSessionContext(await headers(serviceClaims), { db: fixture.db })).credential).toBe("none");
      await fixture.db.destroy();
    }
    for (const changes of [{ tid: TENANT_B }, { azp: "unconfigured" }, { preferred_username: "human" }]) {
      expect((await resolveSessionContext(await headers({ ...serviceClaims, ...changes }))).credential).toBe("none");
    }
  });

  test("service membership cannot contradict its explicit credential", async () => {
    const { db } = serviceRegistry();
    expect((await resolveSessionContext(await headers({ ...serviceClaims, organization: { beta: { id: "org-b" } } }), { db })).credential).toBe("none");
    await db.destroy();
  });

  test("API keys retain scoped service access and validate exchanged tid, client and registry", async () => {
    const apiKey = mintApiKey();
    const integrationId = "44444444-4444-4444-8444-444444444444";
    const keyMaterial = `fixture:${Buffer.alloc(32, 7).toString("base64")}`;
    process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS = keyMaterial;
    const secret = encryptSecret(keyringFromEnv(keyMaterial)!, integrationId, "clientSecret", "synthetic-secret");
    const issuer = new URL("/realms/host", server.url).href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = issuer;
    // The database credential, not the deployment service allowlist, grants this client access.
    delete process.env.OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES;
    const credentialRows = (query: CompiledQuery) => {
      if (query.sql.includes("from platform.api_keys")) return [{
        id: "55555555-5555-4555-8555-555555555555", tenant_id: TENANT_A,
        integration_id: integrationId, secret_hash: apiKey.secretHash,
        role_subset: ["Records.Read"], expires_at: null, revoked_at: null,
      }];
      if (query.sql.includes("from platform.api_key_integrations")) return [{
        keycloak_client_id: clientId, status: "active", client_secret_ciphertext: secret.ciphertext,
        client_secret_key_id: secret.keyId, client_secret_algorithm: secret.algorithm,
      }];
      return undefined;
    };
    const request = new Headers({ authorization: `Bearer ${apiKey.token}` });
    for (const scenario of [
      { realm: "host", claims: {}, allowed: true },
      { realm: "other", claims: {}, allowed: false },
      { realm: "host", claims: { tid: TENANT_B }, allowed: false },
      { realm: "host", claims: { azp: "sibling" }, allowed: false },
    ]) {
      __resetExchangeCacheForTests();
      const tokenHeaders = await headers({ ...serviceClaims, iss: issuer,
        resource_access: { api: { roles: ["Records.Read", "Records.Write"] } }, ...scenario.claims });
      exchangeToken = tokenHeaders.get("authorization")!.slice("Bearer ".length);
      const { db, queries } = serviceRegistry(scenario.realm, "org-a", credentialRows);
      const session = await resolveSessionContext(request, { db });
      expect(session.credential).toBe(scenario.allowed ? "api-key" : "none");
      if (scenario.allowed) {
        expect(session.tenantId).toBe(TENANT_A);
        expect(session.roles).toEqual(["Records.Read"]);
        const count = queries.length;
        expect((await resolveSessionContext(request, { db, requiredAudience: RESOURCE })).credential).toBe("none");
        expect(queries).toHaveLength(count);
      }
      await db.destroy();
    }
    expect(exchangeCalls).toBe(4);
  });
});
