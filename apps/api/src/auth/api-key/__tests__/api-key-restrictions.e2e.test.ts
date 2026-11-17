// SPDX-License-Identifier: BUSL-1.1
/**
 * End-to-end proof for WHERE an integration key may be used from and what a
 * browser key may call (auth/api-key/restrictions.ts), against a real realm
 * and database:
 *
 *   - an IP allowlist admits the listed networks and refuses the rest, the
 *     address being the one the API derived through its trusted proxy hop and
 *     never one a client names;
 *   - a server key is refused whenever a browser presents it;
 *   - a browser key works only from its web sites and only on its listed
 *     endpoints (deny by default), gets the CORS handshake there, and cannot
 *     reach GraphQL or any other route by naming an allowed site;
 *   - the lists are edited on the integration and apply on the next request.
 *
 * Needs the compose Keycloak (8181) with the generated test realm, and a
 * migrated database. Skips wholesale when either is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8181";
const REALM = process.env.E2E_KEYCLOAK_REALM ?? "openshapeforge";
const REALM_URL = `${KEYCLOAK_URL}/realms/${REALM}`;
const ISSUER = process.env.E2E_KEYCLOAK_ISSUER ?? (await discoverIssuer()) ?? REALM_URL;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/openshapeforge_dev";
const ROLE_CLIENT = "erp-provider";
const MANAGE_ROLE = "Platform.ApiKeys.Manage";
const READ_ROLE = "Relations.All.Read";
const WRITE_ROLE = "Relations.All.ReadWrite";
const ADMIN_CLIENT = "openshapeforge-apikey-provisioner";
const ADMIN_SECRET = process.env.E2E_KEYCLOAK_ADMIN_SECRET ?? "openshapeforge-apikey-provisioner-secret";
const SHOP = "https://shop.example.com";
const OTHER_SITE = "https://evil.example.com";

async function discoverIssuer(): Promise<string | null> {
  try {
    const response = await fetch(`${REALM_URL}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const issuer = ((await response.json()) as { issuer?: unknown }).issuer;
    return typeof issuer === "string" && issuer ? issuer : null;
  } catch {
    return null;
  }
}

process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = `${REALM_URL}/protocol/openid-connect/certs`;
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = ROLE_CLIENT;
process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS ??= `e2e:${randomBytes(32).toString("base64")}`;
process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = KEYCLOAK_URL;
process.env.OPENSHAPEFORGE_KEYCLOAK_REALM = REALM;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID = ADMIN_CLIENT;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET = ADMIN_SECRET;
process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??= "openshapeforge-local-dev-context-secret";
process.env.DATABASE_URL = DATABASE_URL;

const { createApiApp } = await import("../../../roles/api.js");
const { __resetSessionResolverForTests } = await import("../../identity.js");
const { __resetExchangeCacheForTests } = await import("../exchange.js");
const { KeycloakAdmin } = await import("../keycloak-admin.js");
const { REST_MOUNT_PATH } = await import("../../../rest/rest-paths.js");
const { createDatabaseRuntime, readMigrateDatabaseUrl } = await import("../../../db/connection.js");
const { seedKeycloakTokenPeople } = await import("../../../graphql/__tests__/e2e/keycloak.js");
const { sql } = await import("kysely");

type App = Awaited<ReturnType<typeof createApiApp>>;

async function masterToken(): Promise<string | null> {
  try {
    const response = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: process.env.E2E_KEYCLOAK_MASTER_USER ?? "admin",
        password: process.env.E2E_KEYCLOAK_MASTER_PASSWORD ?? "admin",
      }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

async function realmAdmin(method: string, path: string, body?: unknown): Promise<Response> {
  const token = await masterToken();
  return fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The provisioner client and the roles the acting administrator needs. */
async function prepareRealm(): Promise<boolean> {
  if (!(await masterToken())) return false;
  let found = (await (await realmAdmin("GET", `/clients?clientId=${ADMIN_CLIENT}`)).json()) as Array<{ id: string }>;
  if (!found[0]) {
    await realmAdmin("POST", "/clients", {
      clientId: ADMIN_CLIENT, secret: ADMIN_SECRET, protocol: "openid-connect", publicClient: false,
      serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false, enabled: true,
    });
    found = (await (await realmAdmin("GET", `/clients?clientId=${ADMIN_CLIENT}`)).json()) as Array<{ id: string }>;
  }
  const provisioner = found[0]?.id;
  if (!provisioner) return false;
  const account = (await (await realmAdmin("GET", `/clients/${provisioner}/service-account-user`)).json()) as { id?: string };
  const rm = ((await (await realmAdmin("GET", "/clients?clientId=realm-management")).json()) as Array<{ id: string }>)[0];
  if (!account.id || !rm) return false;
  const rmRoles = (await (await realmAdmin("GET", `/clients/${rm.id}/roles`)).json()) as Array<{ id: string; name: string }>;
  await realmAdmin("POST", `/users/${account.id}/role-mappings/clients/${rm.id}`,
    rmRoles.filter((role) => ["manage-clients", "manage-users"].includes(role.name)));

  const roleClient = ((await (await realmAdmin("GET", `/clients?clientId=${ROLE_CLIENT}`)).json()) as Array<{ id: string }>)[0];
  const user = ((await (await realmAdmin("GET", "/users?username=tenant-a-admin&exact=true")).json()) as Array<{ id: string }>)[0];
  if (!roleClient || !user) return false;
  const wanted = [MANAGE_ROLE, READ_ROLE, WRITE_ROLE];
  const roles = (await (await realmAdmin("GET", `/clients/${roleClient.id}/roles?max=2000`)).json()) as Array<{ id: string; name: string }>;
  for (const name of wanted) {
    if (!roles.some((role) => role.name === name)) await realmAdmin("POST", `/clients/${roleClient.id}/roles`, { name });
  }
  const all = (await (await realmAdmin("GET", `/clients/${roleClient.id}/roles?max=2000`)).json()) as Array<{ id: string; name: string }>;
  await realmAdmin("POST", `/users/${user.id}/role-mappings/clients/${roleClient.id}`, all.filter((role) => wanted.includes(role.name)));
  return true;
}

async function userToken(username: string, password = "test"): Promise<string | null> {
  const response = await fetch(`${REALM_URL}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: process.env.E2E_KEYCLOAK_CLIENT_ID ?? "openshapeforge-gateway",
      client_secret: process.env.E2E_KEYCLOAK_CLIENT_SECRET ?? "dev-secret",
      username,
      password,
    }).toString(),
  });
  if (!response.ok) return null;
  return ((await response.json()) as { access_token?: string }).access_token ?? null;
}

let app: App | undefined;
let adminToken: string | null = null;
const provisioned: string[] = [];

const ready = await (async () => {
  try {
    const up = await fetch(`${REALM_URL}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(2500) });
    if (!up.ok || !(await prepareRealm())) return false;
  } catch {
    return false;
  }
  adminToken = await userToken("tenant-a-admin");
  return adminToken !== null;
})();

beforeAll(async () => {
  if (!ready) return;
  const seed = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl() });
  try { await seedKeycloakTokenPeople(seed.db, [adminToken]); } finally { await seed.close(); }
  __resetSessionResolverForTests();
  __resetExchangeCacheForTests();
  app = createApiApp({ cors: false, databaseUrl: DATABASE_URL });
  await app.ready();
});

afterAll(async () => {
  const admin = new KeycloakAdmin({ baseUrl: KEYCLOAK_URL, realm: REALM, clientId: ADMIN_CLIENT, clientSecret: ADMIN_SECRET });
  for (const id of provisioned) {
    try { await admin.deleteClient(`osf-int-${id}`); } catch { /* best effort */ }
  }
  if (provisioned.length > 0) {
    const runtime = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl() });
    try {
      await sql`delete from platform.api_key_integrations where id = any(${`{${provisioned.join(",")}}`}::uuid[])`.execute(runtime.db);
    } catch { /* best effort */ } finally { await runtime.close(); }
  }
  await app?.close();
});

// ---------------------------------------------------------------------------

async function catalog(path: string, body: Record<string, unknown>) {
  const response = await app!.inject({
    method: "POST",
    url: `/api/api-key-integrations/${path}`,
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    payload: JSON.stringify({ confirmed: true, ...body }),
  });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

async function integration(body: Record<string, unknown>): Promise<{ id: string; secret: string; integration: any }> {
  const created = await catalog("create", { displayName: `e2e restrictions ${randomUUID().slice(0, 8)}`, ...body });
  expect(created.status).toBe(200);
  provisioned.push(created.body.integration.integrationId);
  return { id: created.body.integration.integrationId, secret: created.body.credential.secret, integration: created.body.integration };
}

const restrict = (integrationId: string, restrictions: Record<string, unknown>) =>
  catalog("update-restrictions", { integrationId, ...restrictions });

function read(secret: string, headers: Record<string, string> = {}) {
  return app!.inject({
    method: "GET",
    url: `${REST_MOUNT_PATH}/relations`,
    headers: { authorization: `Bearer ${secret}`, ...headers },
  });
}

const code = (response: { body: string }) => (JSON.parse(response.body) as { error?: { code?: string } }).error?.code;

async function graphqlWrite(secret: string, headers: Record<string, string> = {}) {
  const response = await app!.inject({
    method: "POST",
    url: "/api/graphql",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...headers },
    payload: JSON.stringify({
      query: `mutation { createRelation(input: { displayName: "rk-${randomUUID().slice(0, 8)}", relationType: "person" }) { data { id } error { code } } }`,
    }),
  });
  const body = JSON.parse(response.body) as {
    error?: { code?: string };
    errors?: Array<{ extensions?: { code?: string } }>;
    data?: { createRelation?: { data?: { id?: string } | null; error?: { code?: string } | null } | null } | null;
  };
  return {
    status: response.statusCode,
    code: body.error?.code ?? body.errors?.[0]?.extensions?.code ?? body.data?.createRelation?.error?.code,
    id: body.data?.createRelation?.data?.id,
  };
}

const RELATIONS = `${REST_MOUNT_PATH}/relations`;

describe.skipIf(!ready)("API key restrictions end to end", () => {
  test("invalid addresses, web sites and endpoints are refused when the integration is created", async () => {
    for (const restriction of [
      { allowedIps: ["example.com"] },
      { allowedIps: ["10.0.0.0/33"] },
      { allowedOrigins: ["http://shop.example.com"] },
      { allowedOrigins: ["https://*.example.com"] },
      { allowedEndpoints: ["/api/rest/v1/relations"] },
      { allowedEndpoints: ["POST /api/graphql"] },
      { allowedEndpoints: ["POST /api/api-key-integrations/create"] },
    ]) {
      expect((await catalog("create", { displayName: "invalid", roles: [READ_ROLE], ...restriction })).status).toBe(400);
    }
  }, 60_000);

  test("an IP allowlist admits only its networks, through the trusted proxy hop", async () => {
    const created = await integration({ roles: [READ_ROLE], allowedIps: ["203.0.113.0/24"] });
    expect(created.integration.allowedIps).toEqual(["203.0.113.0/24"]);
    expect(created.integration.allowedOrigins).toEqual([]);
    expect(created.integration.allowedEndpoints).toEqual([]);

    const outside = await read(created.secret);
    expect(outside.statusCode).toBe(403);
    expect(code(outside)).toBe("API_KEY_RESTRICTED");
    // The server's own header, named by a client, is discarded.
    expect((await read(created.secret, { "x-openshapeforge-client-address": "203.0.113.5" })).statusCode).toBe(403);
    expect((await read(created.secret, { "x-forwarded-for": "203.0.113.5" })).statusCode).toBe(200);
    // A client-prepended address is not the hop the API trusts.
    expect((await read(created.secret, { "x-forwarded-for": "203.0.113.5, 192.0.2.1" })).statusCode).toBe(403);

    // Edited on the integration; the existing key follows on its next request.
    const cleared = await restrict(created.id, { allowedIps: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.allowedIps).toEqual([]);
    expect((await read(created.secret)).statusCode).toBe(200);
  }, 60_000);

  test("a server key is refused when a browser presents it", async () => {
    const created = await integration({ roles: [READ_ROLE] });
    expect((await read(created.secret)).statusCode).toBe(200);
    const fromBrowser = await read(created.secret, { origin: SHOP });
    expect(fromBrowser.statusCode).toBe(403);
    expect(code(fromBrowser)).toBe("API_KEY_RESTRICTED");
  }, 30_000);

  test("a browser key calls only its listed endpoints, from its own sites, and nothing else", async () => {
    const created = await integration({
      roles: [READ_ROLE, WRITE_ROLE],
      allowedOrigins: [SHOP],
      allowedEndpoints: ["get /api/rest/v1/relations"],
    });
    expect(created.integration.allowedOrigins).toEqual([SHOP]);
    expect(created.integration.allowedEndpoints).toEqual(["GET /api/rest/v1/relations"]);

    // The preflight carries no key, so it is answered generically and never with credentials.
    const preflight = await app!.inject({
      method: "OPTIONS",
      url: RELATIONS,
      headers: { origin: SHOP, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(SHOP);
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
    const graphqlPreflight = await app!.inject({
      method: "OPTIONS",
      url: "/api/graphql",
      headers: { origin: SHOP, "access-control-request-method": "POST" },
    });
    expect(graphqlPreflight.headers["access-control-allow-origin"]).toBeUndefined();

    // The one listed endpoint, from the listed site.
    const listed = await read(created.secret, { origin: SHOP });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["access-control-allow-origin"]).toBe(SHOP);
    expect(listed.headers["access-control-allow-credentials"]).toBeUndefined();

    // Not listed: another endpoint, GraphQL (even a write its roles allow), a non-Operation route.
    const other = await app!.inject({
      method: "GET", url: `${RELATIONS}/${randomUUID()}`, headers: { authorization: `Bearer ${created.secret}`, origin: SHOP },
    });
    expect(other.statusCode).toBe(403);
    expect(code(other)).toBe("API_KEY_RESTRICTED");
    const write = await graphqlWrite(created.secret, { origin: SHOP });
    expect(write.id).toBeUndefined();
    expect(write.code).toBe("API_KEY_RESTRICTED");
    const lease = await app!.inject({
      method: "POST",
      url: "/api/operation-leases",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.secret}`, origin: SHOP },
      payload: JSON.stringify({ operationId: "relations.update", targetId: randomUUID() }),
    });
    expect(lease.statusCode).toBe(403);
    expect(code(lease)).toBe("API_KEY_RESTRICTED");

    // Another site, or none at all: refused.
    expect((await read(created.secret, { origin: OTHER_SITE })).statusCode).toBe(403);
    expect((await read(created.secret)).statusCode).toBe(403);

    // Editing one list leaves the others as they were.
    const fenced = await restrict(created.id, { allowedIps: ["203.0.113.0/24"] });
    expect(fenced.body.allowedOrigins).toEqual([SHOP]);
    expect(fenced.body.allowedEndpoints).toEqual(["GET /api/rest/v1/relations"]);
    expect((await read(created.secret, { origin: SHOP })).statusCode).toBe(403);
    expect((await read(created.secret, { origin: SHOP, "x-forwarded-for": "203.0.113.9" })).statusCode).toBe(200);

    // Deny by default: with no endpoints listed it calls nothing.
    expect((await restrict(created.id, { allowedIps: [], allowedEndpoints: [] })).status).toBe(200);
    const nothing = await read(created.secret, { origin: SHOP });
    expect(nothing.statusCode).toBe(403);
    expect(code(nothing)).toBe("API_KEY_RESTRICTED");

    // No web sites: a server key again, which writes and is refused from browsers.
    expect((await restrict(created.id, { allowedOrigins: [] })).status).toBe(200);
    expect((await graphqlWrite(created.secret)).id).toBeDefined();
    expect((await read(created.secret, { origin: SHOP })).statusCode).toBe(403);
  }, 90_000);
});
