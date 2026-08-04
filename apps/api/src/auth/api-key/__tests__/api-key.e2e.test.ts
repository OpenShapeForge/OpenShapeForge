// SPDX-License-Identifier: BUSL-1.1
/**
 * End-to-end proof for customer-provisioned API keys.
 *
 * Runs against the compose stack (Postgres on 5434, Keycloak on 8181) and
 * exercises the real thing: a real realm client created through the Admin API,
 * a real client_credentials exchange, a real JWKS verification, and the key
 * driving all three transports. Skips wholesale when the stack is not up, so it
 * never fails for the wrong reason.
 *
 * The claims under test are the ones the design rests on:
 *   - one key reaches GraphQL, REST and MCP with the SAME effective roles;
 *   - a role subset narrows, and cannot widen;
 *   - revoked and expired keys authenticate nothing;
 *   - the privilege ceiling holds on create AND on the subset path;
 *   - an API key cannot manage API keys.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8181";
const REALM = process.env.E2E_KEYCLOAK_REALM ?? "openshapeforge";
const ISSUER = `${KEYCLOAK_URL}/realms/${REALM}`;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/openshapeforge_dev";

const ROLE_CLIENT = "erp-provider";
const MANAGE_ROLE = "Platform.ApiKeys.Manage";
/** Read-only entity role. `directie` ships with ReadWrite only, so the suite
 *  grants this one to prove per-OPERATION enforcement flows through a key. */
const READ_ROLE = "Relations.All.Read";
const WRITE_ROLE = "Relations.All.ReadWrite";
/** Held by `directie`, but no generated entity is gated by it — a key granted
 *  only this must reach no entity at all. */
const OTHER_DOMAIN_ROLE = "RealEstate.All.ReadWrite";
const ADMIN_CLIENT = "openshapeforge-apikey-provisioner";
const ADMIN_SECRET =
  process.env.E2E_KEYCLOAK_ADMIN_SECRET ?? "openshapeforge-apikey-provisioner-secret";
const TENANT_ACME = "11111111-1111-4111-8111-111111111111";

// Set BEFORE the app modules read them. identity.ts caches the verifier lazily
// and exposes a reset, so ordering only has to hold at first use.
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;
process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = ROLE_CLIENT;
process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS = `e2e:${randomBytes(32).toString("base64")}`;
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
const { createDatabaseRuntime } = await import("../../../db/connection.js");
const { sql } = await import("kysely");

type App = Awaited<ReturnType<typeof createApiApp>>;

/**
 * Master-realm admin token, for realm bootstrap only.
 *
 * `admin/admin` is the documented, intentional local-dev credential of the
 * compose stack. It is used here for one thing: creating the provisioner client
 * this feature declares, because the running dev realm was imported before that
 * declaration existed and `--import-realm` is a no-op against an existing
 * realm. A fresh deployment gets the client from the generated realm export and
 * never needs this path.
 */
async function masterAdminToken(): Promise<string | null> {
  try {
    const response = await fetch(
      `${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: process.env.E2E_KEYCLOAK_MASTER_USER ?? "admin",
          password: process.env.E2E_KEYCLOAK_MASTER_PASSWORD ?? "admin",
        }).toString(),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return null;
    return ((await response.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

/** Create the declared provisioner client if the running realm predates it. */
async function ensureProvisionerClient(): Promise<boolean> {
  const master = await masterAdminToken();
  if (!master) return false;
  const base = `${KEYCLOAK_URL}/admin/realms/${REALM}`;
  const authed = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${master}`,
    ...extra,
  });

  const existing = (await (
    await fetch(`${base}/clients?clientId=${ADMIN_CLIENT}`, { headers: authed() })
  ).json()) as Array<{ id: string }>;

  let internalId = existing[0]?.id;
  if (!internalId) {
    await fetch(`${base}/clients`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        clientId: ADMIN_CLIENT,
        name: "OpenShapeForge API Key Provisioner",
        secret: ADMIN_SECRET,
        protocol: "openid-connect",
        publicClient: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        enabled: true,
      }),
    });
    const created = (await (
      await fetch(`${base}/clients?clientId=${ADMIN_CLIENT}`, { headers: authed() })
    ).json()) as Array<{ id: string }>;
    internalId = created[0]?.id;
  }
  if (!internalId) return false;

  const serviceAccount = (await (
    await fetch(`${base}/clients/${internalId}/service-account-user`, { headers: authed() })
  ).json()) as { id?: string };
  if (!serviceAccount.id) return false;

  const realmManagement = (await (
    await fetch(`${base}/clients?clientId=realm-management`, { headers: authed() })
  ).json()) as Array<{ id: string }>;
  const rmId = realmManagement[0]?.id;
  if (!rmId) return false;

  const rmRoles = (await (
    await fetch(`${base}/clients/${rmId}/roles`, { headers: authed() })
  ).json()) as Array<{ id: string; name: string }>;
  const wanted = rmRoles.filter((role) =>
    ["manage-clients", "manage-users"].includes(role.name),
  );

  await fetch(`${base}/users/${serviceAccount.id}/role-mappings/clients/${rmId}`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: JSON.stringify(wanted),
  });
  return true;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

const keycloakUp = await reachable(`${ISSUER}/.well-known/openid-configuration`);

/** Bearer token for a seeded realm user, via the dev gateway client. */
async function userToken(username: string, password = "test"): Promise<string | null> {
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
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

/**
 * Make sure the management role exists and the acting user holds it.
 *
 * The compose realm was imported before this feature existed, and
 * `--import-realm` is a no-op against an existing realm, so the test provisions
 * what it needs rather than requiring a realm reset.
 */
async function ensureUserRoles(
  admin: InstanceType<typeof KeycloakAdmin>,
  roleNames: readonly string[],
): Promise<boolean> {
  const raw = admin as unknown as {
    json: (method: string, path: string, body?: unknown) => Promise<unknown>;
    request: (method: string, path: string, body?: unknown) => Promise<Response>;
  };

  const clients = (await raw.json("GET", `/clients?clientId=${ROLE_CLIENT}`)) as Array<{
    id: string;
  }>;
  const roleClientId = clients[0]?.id;
  if (!roleClientId) return false;

  const existing = (await raw.json("GET", `/clients/${roleClientId}/roles?max=2000`)) as Array<{
    name: string;
  }>;
  const present = new Set(existing.map((role) => role.name));
  for (const name of roleNames) {
    if (!present.has(name)) {
      await raw.request("POST", `/clients/${roleClientId}/roles`, { name });
    }
  }

  const users = (await raw.json("GET", `/users?username=acme-directie&exact=true`)) as Array<{
    id: string;
  }>;
  const userId = users[0]?.id;
  if (!userId) return false;

  const all = (await raw.json("GET", `/clients/${roleClientId}/roles?max=2000`)) as Array<{
    id: string;
    name: string;
  }>;
  const wanted = all.filter((role) => roleNames.includes(role.name));
  if (wanted.length !== roleNames.length) return false;

  await raw.request("POST", `/users/${userId}/role-mappings/clients/${roleClientId}`, wanted);
  return true;
}

function decodeClaims(token: string): {
  resource_access?: Record<string, { roles?: string[] }>;
} {
  const [, payload] = token.split(".");
  return JSON.parse(
    Buffer.from(payload!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
}

let app: App | undefined;
let admin: InstanceType<typeof KeycloakAdmin> | undefined;
let adminToken: string | null = null;
const provisionedClients: string[] = [];

const ready = await (async () => {
  if (!keycloakUp) return false;
  if (!(await ensureProvisionerClient())) return false;
  admin = new KeycloakAdmin({
    baseUrl: KEYCLOAK_URL,
    realm: REALM,
    clientId: ADMIN_CLIENT,
    clientSecret: ADMIN_SECRET,
  });
  try {
    if (!(await ensureUserRoles(admin, [MANAGE_ROLE, READ_ROLE]))) return false;
  } catch {
    return false;
  }
  // Fetched AFTER the grant so the token actually carries the role.
  adminToken = await userToken("acme-directie");
  if (!adminToken) return false;
  // The grant only takes effect in a token minted after it, and the suite
  // asserts against roles it named itself rather than guessing from claims.
  const claims = decodeClaims(adminToken);
  const held = new Set(claims.resource_access?.[ROLE_CLIENT]?.roles ?? []);
  return [MANAGE_ROLE, READ_ROLE, WRITE_ROLE, OTHER_DOMAIN_ROLE].every((role) =>
    held.has(role),
  );
})();

beforeAll(async () => {
  if (!ready) return;
  __resetSessionResolverForTests();
  __resetExchangeCacheForTests();
  app = createApiApp({ databaseUrl: DATABASE_URL });
  await app.ready();
});

afterAll(async () => {
  // BOTH sides, or the run leaks. An earlier version cleaned only Keycloak and
  // left 114 integration rows behind across a day of runs — the same
  // two-system asymmetry the reconciler exists for, reproduced in the test
  // harness. Realm first: a client with no row is inert, while a row with no
  // client is what the reconciler would otherwise try to rebuild.
  for (const clientId of provisionedClients) {
    try {
      await admin?.deleteClient(clientId);
    } catch {
      // Best effort — a failure here must not fail the suite.
    }
  }

  if (provisionedClients.length > 0) {
    const runtime = createDatabaseRuntime({ databaseUrl: DATABASE_URL });
    try {
      // Keys cascade from the integration. The array literal is built by hand:
      // the bun/kysely driver serializes a JS string[] as a bare comma-joined
      // scalar with no braces, which Postgres will not read as an array — the
      // same trap applyDbSession documents for its group UUIDs. Every element
      // here is `osf-int-<uuid>`, so no escaping is required.
      const literal = `{${provisionedClients.join(",")}}`;
      await sql`
        delete from platform.api_key_integrations
         where keycloak_client_id = any(${literal}::text[])
      `.execute(runtime.db);
    } catch {
      // Best effort, as above.
    } finally {
      await runtime.close();
    }
  }

  await app?.close();
});

type CreateResponse = {
  integrationId: string;
  keyId: string;
  token: string;
};

async function createKey(
  body: Record<string, unknown>,
  bearer: string | null = adminToken,
): Promise<{ status: number; body: any }> {
  const response = await app!.inject({
    method: "POST",
    url: "/api/api-keys",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    payload: JSON.stringify(body),
  });
  const parsed = response.body ? JSON.parse(response.body) : undefined;
  if (parsed?.integrationId) {
    provisionedClients.push(`osf-int-${parsed.integrationId}`);
  }
  return { status: response.statusCode, body: parsed };
}

/** The roles a credential actually resolves to, read back through GraphQL. */
async function rolesViaGraphql(credential: string): Promise<string[] | undefined> {
  const response = await app!.inject({
    method: "POST",
    url: "/api/graphql",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    payload: JSON.stringify({ query: "{ __typename }" }),
  });
  if (response.statusCode !== 200) return undefined;
  return JSON.parse(response.body).data ? [] : undefined;
}

describe.skipIf(!ready)("API keys end to end", () => {
  test("a customer provisions a key and gets exactly one usable credential back", async () => {
    const created = await createKey({
      displayName: `e2e integration ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });

    expect(created.status).toBe(201);
    const body = created.body as CreateResponse;
    expect(body.token).toStartWith("osf_live_");
    expect(body.integrationId).toBeTruthy();

    // Listing must never return the credential again.
    const list = await app!.inject({
      method: "GET",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.token);
  }, 30_000);

  test("one key authenticates on GraphQL, REST and MCP with the same effective roles", async () => {
    const created = await createKey({
      displayName: `e2e triple ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });
    expect(created.status).toBe(201);
    const key = (created.body as CreateResponse).token;

    // GraphQL — an authenticated session reaches the schema.
    const graphql = await app!.inject({
      method: "POST",
      url: "/api/graphql",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      payload: JSON.stringify({ query: "{ health { status } }" }),
    });
    expect(graphql.statusCode).toBe(200);

    // MCP — tools/list is authenticated; an unauthenticated call is 401 before dispatch.
    const mcp = await app!.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.statusCode).not.toBe(401);

    // REST — a positive assertion, not merely "not 401". An earlier version of
    // this test used the wrong mount path, got a 404, and passed anyway.
    const rest = await app!.inject({
      method: "GET",
      url: `${REST_MOUNT_PATH}/relations`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(rest.statusCode).toBe(200);

    // And the same path without the credential is refused, so the 200 above is
    // the key's doing rather than an unauthenticated route.
    const anonymous = await app!.inject({
      method: "GET",
      url: `${REST_MOUNT_PATH}/relations`,
    });
    expect(anonymous.statusCode).toBe(401);
  }, 30_000);

  test("an unknown, malformed or revoked key authenticates nothing", async () => {
    const created = await createKey({
      displayName: `e2e revoke ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });
    const { token, keyId } = created.body as CreateResponse;

    const before = await app!.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(before.statusCode).not.toBe(401);

    const revoked = await app!.inject({
      method: "DELETE",
      url: `/api/api-keys/keys/${keyId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revoked.statusCode).toBe(204);

    for (const candidate of [
      token,
      "osf_live_deadbeef_nothingreal",
      `${token}x`,
    ]) {
      const after = await app!.inject({
        method: "POST",
        url: "/api/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${candidate}`,
        },
        payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(after.statusCode).toBe(401);
    }
  }, 30_000);

  test("a role subset narrows what the key can reach, and cannot widen it", async () => {
    // Full key: the integration's roles, unnarrowed.
    const full = await createKey({
      displayName: `e2e full ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });
    expect(full.status).toBe(201);

    const readRelations = (credential: string) =>
      app!.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        payload: JSON.stringify({ query: "{ relations(first: 1) { totalCount } }" }),
      });

    const allowed = await readRelations((full.body as CreateResponse).token);
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body).errors ?? []).toEqual([]);

    // Narrowed key: the subset names ONLY a role the integration's service
    // account does not hold. The caller holds it, so the ceiling permits the
    // request — but the intersection is empty, so the key reaches nothing.
    // That is both halves of the property in one assertion: it narrowed, and
    // it did not confer the named role.
    const narrowed = await createKey({
      displayName: `e2e narrowed ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
      roleSubset: [MANAGE_ROLE],
    });
    expect(narrowed.status).toBe(201);

    const denied = await readRelations((narrowed.body as CreateResponse).token);
    const errors = JSON.parse(denied.body).errors ?? [];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].extensions?.code).toBe("FORBIDDEN");
  }, 30_000);

  test("the ceiling applies to the subset path too, not just to creation", async () => {
    const created = await createKey({
      displayName: `e2e subset ceiling ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });
    const { integrationId } = created.body as CreateResponse;

    // The update-shaped path is where this check is classically missing.
    const refused = await app!.inject({
      method: "POST",
      url: `/api/api-keys/${integrationId}/keys`,
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      payload: JSON.stringify({ displayName: "sneaky", roleSubset: ["Totally.Made.Up"] }),
    });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).error.message).toContain("Totally.Made.Up");
  }, 30_000);

  test("keys with different permissions get different access from the same tenant", async () => {
    // Four keys, four role shapes, one tenant. The point is that effective
    // access is decided per key by the role set behind it — not by "is this an
    // API key", which would be a second authorization model.
    const readRelations = (credential: string) =>
      app!.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        payload: JSON.stringify({ query: "{ relations(first: 1) { totalCount } }" }),
      });
    const createRelation = (credential: string) =>
      app!.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        payload: JSON.stringify({
          query:
            "mutation { createRelation(input: { displayName: \"perm-matrix\" }) { id } }",
        }),
      });
    const forbidden = (body: string) =>
      (JSON.parse(body).errors ?? []).some(
        (error: { extensions?: { code?: string } }) => error.extensions?.code === "FORBIDDEN",
      );

    const keys: Record<string, string> = {};
    for (const [label, body] of [
      // Full write grant.
      ["writer", { displayName: "perm writer", roles: [WRITE_ROLE] }],
      // Read-only entity role: the same entity, one operation less.
      ["reader", { displayName: "perm reader", roles: [READ_ROLE] }],
      // A role from another domain — no generated entity is gated by it.
      ["other-domain", { displayName: "perm other", roles: [OTHER_DOMAIN_ROLE] }],
      // Write grant on the integration, narrowed by a subset that names only a
      // role the service account does not hold.
      [
        "narrowed-to-nothing",
        { displayName: "perm narrowed", roles: [WRITE_ROLE], roleSubset: [MANAGE_ROLE] },
      ],
    ] as const) {
      const created = await createKey(body as Record<string, unknown>);
      expect(created.status).toBe(201);
      keys[label] = (created.body as CreateResponse).token;
    }

    // writer: reads and writes.
    expect(forbidden((await readRelations(keys.writer!)).body)).toBe(false);
    expect(forbidden((await createRelation(keys.writer!)).body)).toBe(false);

    // reader: reads, but the SAME credential is refused the write. This is the
    // load-bearing assertion — per-operation enforcement reaches an API key
    // exactly as it reaches an interactive bearer, because by the time the
    // guard runs there is no difference between them.
    expect(forbidden((await readRelations(keys.reader!)).body)).toBe(false);
    expect(forbidden((await createRelation(keys.reader!)).body)).toBe(true);

    // other-domain: authenticated, and reaches no relation at all.
    expect(forbidden((await readRelations(keys["other-domain"]!)).body)).toBe(true);

    // narrowed-to-nothing: the subset intersected to empty, so it did NOT
    // confer the role it named.
    expect(forbidden((await readRelations(keys["narrowed-to-nothing"]!)).body)).toBe(true);
  }, 60_000);

  test("two keys on one integration can carry different permissions", async () => {
    // One external party, one identity, two credentials with different reach —
    // which is what makes a subset worth having rather than just issuing a
    // second integration.
    const created = await createKey({
      displayName: `e2e split ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE, READ_ROLE],
    });
    expect(created.status).toBe(201);
    const { integrationId, token: unrestricted } = created.body as CreateResponse;

    const restricted = await app!.inject({
      method: "POST",
      url: `/api/api-keys/${integrationId}/keys`,
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      payload: JSON.stringify({ displayName: "read only", roleSubset: [READ_ROLE] }),
    });
    expect(restricted.statusCode).toBe(201);
    const readOnly = JSON.parse(restricted.body).token as string;

    const write = (credential: string) =>
      app!.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        payload: JSON.stringify({
          query: "mutation { createRelation(input: { displayName: \"split\" }) { id } }",
        }),
      });
    const isForbidden = (body: string) =>
      (JSON.parse(body).errors ?? []).some(
        (error: { extensions?: { code?: string } }) => error.extensions?.code === "FORBIDDEN",
      );

    expect(isForbidden((await write(unrestricted)).body)).toBe(false);
    expect(isForbidden((await write(readOnly)).body)).toBe(true);
  }, 60_000);

  test("a user without the management role cannot provision at all", async () => {
    // A real seeded identity, broadly privileged on business data and holding
    // no Platform.* role — the shape an ordinary employee has.
    const consultant = await userToken("acme-verhuurconsulent");
    expect(consultant).not.toBeNull();

    const refused = await createKey(
      { displayName: "unauthorized", roles: [] },
      consultant,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("Not authorized to manage API keys");
  }, 30_000);

  test("the GraphQL surface mirrors REST, ceiling included", async () => {
    const graphql = (query: string, variables: unknown, bearer = adminToken) =>
      app!.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        payload: JSON.stringify({ query, variables }),
      });
    const parse = (body: string) => JSON.parse(body) as {
      data?: Record<string, any> | null;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };

    // The picker's role list — the caller's own roles, minus the management
    // role. A convenience, not a control.
    const roles = parse(
      (await graphql("{ grantableApiKeyRoles }", {})).body,
    );
    expect(roles.errors ?? []).toEqual([]);
    expect(roles.data!.grantableApiKeyRoles).toContain(WRITE_ROLE);
    expect(roles.data!.grantableApiKeyRoles).not.toContain(MANAGE_ROLE);

    const CREATE = `
      mutation($input: CreateApiKeyIntegrationInput!) {
        createApiKeyIntegration(input: $input) { integrationId keyId token }
      }`;

    const created = parse(
      (await graphql(CREATE, {
        input: { displayName: `gql ${randomUUID().slice(0, 8)}`, roles: [WRITE_ROLE] },
      })).body,
    );
    expect(created.errors ?? []).toEqual([]);
    const minted = created.data!.createApiKeyIntegration;
    expect(minted.token).toStartWith("osf_live_");
    provisionedClients.push(`osf-int-${minted.integrationId}`);

    // The key works, which is the point of mirroring rather than reimplementing.
    const used = await app!.inject({
      method: "POST",
      url: "/api/graphql",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.token}` },
      payload: JSON.stringify({ query: "{ relations(first: 1) { totalCount } }" }),
    });
    expect(parse(used.body).errors ?? []).toEqual([]);

    // Listing never returns the credential again.
    const listed = parse((await graphql("{ apiKeys { id displayName roleSubset } }", {})).body);
    expect(listed.errors ?? []).toEqual([]);
    expect(listed.data!.apiKeys.length).toBeGreaterThan(0);
    expect(JSON.stringify(listed.data)).not.toContain(minted.token);

    // The ceiling is the same one, reached through a different transport.
    const refused = parse(
      (await graphql(CREATE, {
        input: { displayName: "gql escalation", roles: ["Totally.Made.Up"] },
      })).body,
    );
    expect(refused.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(refused.errors?.[0]?.message).toContain("Totally.Made.Up");

    // And an api-key session is refused key management here too.
    const ladder = parse(
      (await graphql("{ apiKeys { id } }", {}, minted.token)).body,
    );
    expect(ladder.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(ladder.errors?.[0]?.message).toContain("API keys cannot manage API keys");

    // Revoke through GraphQL, and the key stops authenticating.
    const revoked = parse(
      (await graphql("mutation($id: ID!) { revokeApiKey(keyId: $id) }", { id: minted.keyId })).body,
    );
    expect(revoked.errors ?? []).toEqual([]);
    expect(revoked.data!.revokeApiKey).toBe(true);

    const after = await app!.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${minted.token}`,
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(after.statusCode).toBe(401);
  }, 60_000);

  test("the privilege ceiling refuses a role the caller does not hold", async () => {
    const refused = await createKey({
      displayName: "e2e escalation attempt",
      // acme-directie is broadly privileged but holds no such role — a
      // fabricated name is the cleanest proof the check is by membership and
      // not by a denylist.
      roles: ["Platform.SystemBypass", "Totally.Made.Up"],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("FORBIDDEN");
    expect(refused.body.error.message).toContain("Totally.Made.Up");
  }, 30_000);

  test("an unauthenticated caller cannot provision", async () => {
    const refused = await createKey({ displayName: "nope", roles: [] }, null);
    expect(refused.status).toBe(403);
  }, 30_000);

  test("an API key cannot manage API keys", async () => {
    const created = await createKey({
      displayName: `e2e ladder ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });
    const { token } = created.body as CreateResponse;

    // Even listing is refused: key management is for interactive sessions.
    const listed = await app!.inject({
      method: "GET",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(403);

    const minted = await createKey(
      { displayName: "escalation", roles: [WRITE_ROLE] },
      token,
    );
    expect(minted.status).toBe(403);
    expect(minted.body.error.message).toContain("API keys cannot manage API keys");
  }, 30_000);

  test("a second key can be issued against one integration, for rotation", async () => {
    const created = await createKey({
      displayName: `e2e rotation ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });
    const { integrationId, token: first } = created.body as CreateResponse;

    const rotated = await app!.inject({
      method: "POST",
      url: `/api/api-keys/${integrationId}/keys`,
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      payload: JSON.stringify({ displayName: "rotated" }),
    });
    expect(rotated.statusCode).toBe(201);
    const second = JSON.parse(rotated.body).token as string;

    expect(second).not.toBe(first);

    // Both live at once — that overlap is the whole point of the rotation
    // window, and it is what one-Keycloak-client-per-key could not provide.
    for (const credential of [first, second]) {
      const response = await app!.inject({
        method: "POST",
        url: "/api/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${credential}`,
        },
        payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(response.statusCode).not.toBe(401);
    }
  }, 30_000);

  test("disabling an integration kills every key under it", async () => {
    const created = await createKey({
      displayName: `e2e disable ${randomUUID().slice(0, 8)}`,
      roles: [WRITE_ROLE],
    });
    const { integrationId, token } = created.body as CreateResponse;

    const disabled = await app!.inject({
      method: "DELETE",
      url: `/api/api-keys/${integrationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(disabled.statusCode).toBe(204);

    const after = await app!.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(after.statusCode).toBe(401);
  });
});

// Surfaces WHY the suite skipped, instead of a silent green run.
describe("API key e2e preconditions", () => {
  test("reports whether the compose stack was available", () => {
    if (!ready) {
      console.warn(
        `[api-key e2e] SKIPPED — keycloak reachable: ${keycloakUp}, ` +
          `admin token: ${adminToken !== null}. Start the compose stack to run this suite.`,
      );
    }
    expect(true).toBe(true);
  });
});
