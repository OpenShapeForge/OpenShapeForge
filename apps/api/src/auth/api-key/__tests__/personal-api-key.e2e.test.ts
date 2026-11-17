// SPDX-License-Identifier: BUSL-1.1
/**
 * End-to-end proof for personal API keys, against a real realm and a real
 * database: a person mints a key through the canonical REST Operation, the
 * key authenticates through the real session resolver, and every claim the
 * design rests on is exercised as it would be in production:
 *
 *   - the key acts AS its owner (the audit trail names the person);
 *   - it carries the owner's CURRENT roles: withdraw one and the key loses it
 *     on the next request; a narrowing narrows and cannot widen;
 *   - it dies with the owner's access: a disabled realm account, a blocked
 *     membership, expiry and revocation each stop it;
 *   - only the owner sees and manages their own keys; an administrator with
 *     the oversight roles sees everyone's (metadata only) and may revoke,
 *     which the owner then sees; a colleague without them sees nothing;
 *   - no API key, personal or not, can manage API keys.
 *
 * Needs the compose Keycloak (8181) with the generated test realm, and a
 * migrated database. Skips wholesale when either is missing, so it never fails
 * for the wrong reason; CI treats a skip as a failure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8181";
const REALM = process.env.E2E_KEYCLOAK_REALM ?? "openshapeforge";
const REALM_URL = `${KEYCLOAK_URL}/realms/${REALM}`;
const ISSUER = process.env.E2E_KEYCLOAK_ISSUER ?? (await discoverIssuer()) ?? REALM_URL;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://openshapeforge_app:openshapeforge_app@localhost:5434/openshapeforge_dev";
const ROLE_CLIENT = "erp-provider";
const ADMIN_CLIENT = "openshapeforge-apikey-provisioner";
const ADMIN_SECRET = process.env.E2E_KEYCLOAK_ADMIN_SECRET ?? "openshapeforge-apikey-provisioner-secret";

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
// The integration key path too, so a personal key dressed as an integration
// key is refused by that path as unknown rather than as unconfigured.
process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS ??= `e2e:${Buffer.from(randomUUID().replaceAll("-", "")).toString("base64")}`;
process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = KEYCLOAK_URL;
process.env.OPENSHAPEFORGE_KEYCLOAK_REALM = REALM;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID = ADMIN_CLIENT;
process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET = ADMIN_SECRET;
process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??= "openshapeforge-local-dev-context-secret";
process.env.DATABASE_URL = DATABASE_URL;

const { createApiApp } = await import("../../../roles/api.js");
const { __resetSessionResolverForTests } = await import("../../identity.js");
const { createDatabaseRuntime, readMigrateDatabaseUrl } = await import("../../../db/connection.js");
const { SYSTEM_BYPASS_ROLE, withDbSession, withSystemSession } = await import("../../../db/session.js");
const { seedKeycloakTokenPeople } = await import("../../../graphql/__tests__/e2e/keycloak.js");
const { sql } = await import("kysely");

type App = Awaited<ReturnType<typeof createApiApp>>;
type Runtime = ReturnType<typeof createDatabaseRuntime>;

// ---------------------------------------------------------------------------
// Realm setup. `admin/admin` is the compose stack's documented local master
// credential, used only to create what this suite needs and remove it after.

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
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The provisioner client the API reads realm users with (manage-users). */
async function ensureProvisionerClient(): Promise<boolean> {
  const found = (await (await realmAdmin("GET", `/clients?clientId=${ADMIN_CLIENT}`)).json()) as Array<{ id: string }>;
  let id = found[0]?.id;
  if (!id) {
    await realmAdmin("POST", "/clients", {
      clientId: ADMIN_CLIENT, secret: ADMIN_SECRET, protocol: "openid-connect", publicClient: false,
      serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false, enabled: true,
    });
    id = ((await (await realmAdmin("GET", `/clients?clientId=${ADMIN_CLIENT}`)).json()) as Array<{ id: string }>)[0]?.id;
  }
  if (!id) return false;
  const account = (await (await realmAdmin("GET", `/clients/${id}/service-account-user`)).json()) as { id?: string };
  const rm = ((await (await realmAdmin("GET", "/clients?clientId=realm-management")).json()) as Array<{ id: string }>)[0];
  if (!account.id || !rm) return false;
  const roles = (await (await realmAdmin("GET", `/clients/${rm.id}/roles`)).json()) as Array<{ id: string; name: string }>;
  await realmAdmin("POST", `/users/${account.id}/role-mappings/clients/${rm.id}`,
    roles.filter((role) => ["manage-clients", "manage-users"].includes(role.name)));
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

function claims(token: string): { sub: string; tid?: string } {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { sub: string; tid?: string };
}

/**
 * The seeded test realm's people. Their tenant comes from a realm attribute
 * the user profile does not expose, so the suite uses them rather than
 * minting its own. The owner is disabled for one test and re-enabled in that
 * test's `finally` and again in `afterAll`.
 */
const OWNER_USERNAME = "tenant-a-user";
const COLLEAGUE_USERNAME = "tenant-a-no-access";
const OTHER_TENANT_USERNAME = "tenant-b-user";
let ownerRealmId: string | undefined;

async function setOwnerEnabled(enabled: boolean): Promise<void> {
  const current = (await (await realmAdmin("GET", `/users/${ownerRealmId}`)).json()) as Record<string, unknown>;
  const response = await realmAdmin("PUT", `/users/${ownerRealmId}`, { ...current, enabled });
  expect(response.status).toBe(204);
}

// ---------------------------------------------------------------------------

let app: App | undefined;
let seed: Runtime | undefined;
let adminToken: string | null = null;
let ownerToken: string | null = null;
let colleagueToken: string | null = null;
let otherTenantToken: string | null = null;
let tenantId = "";

const OWNER_ROLES = ["Platform.ApiKeys.Personal", "Relations.All.Read", "Relations.All.ReadWrite"];
const COLLEAGUE_ROLES = ["Platform.ApiKeys.Personal", "Relations.All.Read"];
// org_admin expands (role-composites.json) to the oversight roles among others.
const ADMIN_ROLES = ["org_admin"];

async function setMembershipRoles(token: string, roles: readonly string[]): Promise<void> {
  const { sub: subject, tid } = claims(token);
  await withSystemSession(
    seed!.db,
    { actorSubject: "e2e-seed", roles: [SYSTEM_BYPASS_ROLE], reason: "e2e: personal key roles", tenantId: tid! },
    (trx) => sql`
      update platform.identity_relations ir
         set roles = (select coalesce(array_agg(value), '{}'::text[]) from jsonb_array_elements_text(${[...roles]}::jsonb)),
             access_blocked = false, updated_at = now()
        from platform.identities i
       where i.id = ir.identity_id and i.issuer = ${ISSUER} and i.subject = ${subject} and ir.tenant_id = ${tid!}
    `.execute(trx),
  );
}

async function setOwnerBlocked(blocked: boolean): Promise<void> {
  await withSystemSession(
    seed!.db,
    { actorSubject: "e2e-seed", roles: [SYSTEM_BYPASS_ROLE], reason: "e2e: block personal key owner", tenantId },
    (trx) => sql`
      update platform.identity_relations ir set access_blocked = ${blocked}
        from platform.identities i
       where i.id = ir.identity_id and i.issuer = ${ISSUER} and i.subject = ${ownerRealmId!} and ir.tenant_id = ${tenantId}
    `.execute(trx),
  );
}

const ready = await (async () => {
  try {
    if (!(await discoverIssuer())) return false;
    if (!(await masterToken())) return false;
    if (!(await ensureProvisionerClient())) return false;
    adminToken = await userToken("tenant-a-admin");
    ownerToken = await userToken(OWNER_USERNAME);
    colleagueToken = await userToken(COLLEAGUE_USERNAME);
    otherTenantToken = await userToken(OTHER_TENANT_USERNAME);
    if (!adminToken || !ownerToken || !colleagueToken || !otherTenantToken) return false;
    tenantId = claims(adminToken).tid ?? "";
    ownerRealmId = claims(ownerToken).sub;
    return Boolean(tenantId) && claims(ownerToken).tid === tenantId && claims(otherTenantToken).tid !== tenantId;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  if (!ready) return;
  seed = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl() });
  await seedKeycloakTokenPeople(seed.db, [adminToken, ownerToken, colleagueToken, otherTenantToken]);
  await setMembershipRoles(ownerToken!, OWNER_ROLES);
  await setMembershipRoles(colleagueToken!, COLLEAGUE_ROLES);
  await setMembershipRoles(adminToken!, ADMIN_ROLES);
  // An administrator of ANOTHER organization, with every oversight right.
  await setMembershipRoles(otherTenantToken!, ADMIN_ROLES);
  __resetSessionResolverForTests();
  app = createApiApp({ cors: false, databaseUrl: DATABASE_URL });
  await app.ready();
});

afterAll(async () => {
  // Never leave the shared seeded user disabled, whatever happened above.
  if (ownerRealmId) {
    try { await setOwnerEnabled(true); } catch { /* reported by the test that disabled it */ }
  }
  await app?.close();
  await seed?.close();
});

// ---------------------------------------------------------------------------

/** Writes declare `confirmation: acknowledgement`; a deliberate caller confirms. */
const ACKNOWLEDGED = /(^|\/)(create|revoke)$/;

async function op(path: string, body: Record<string, unknown>, bearer: string | null) {
  const response = await app!.inject({
    method: "POST",
    url: `/api/personal-api-keys/${path}`,
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    payload: JSON.stringify(ACKNOWLEDGED.test(path) ? { confirmed: true, ...body } : body),
  });
  return { status: response.statusCode, headers: response.headers, body: response.body ? JSON.parse(response.body) : undefined };
}

async function mint(body: Record<string, unknown>, bearer = ownerToken): Promise<{ id: string; secret: string }> {
  const created = await op("mine/create", { displayName: `e2e ${randomUUID().slice(0, 8)}`, ...body }, bearer);
  expect(created.status).toBe(200);
  return { id: created.body.credential.id, secret: created.body.credential.secret };
}

async function graphql(query: string, credential: string) {
  const response = await app!.inject({
    method: "POST",
    url: "/api/graphql",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    payload: JSON.stringify({ query }),
  });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

type Access = "ok" | "denied" | "unauthenticated";

function outcome(result: { status: number; body: any }, field: string): Access {
  if (result.status === 401) return "unauthenticated";
  const code = result.body?.errors?.[0]?.extensions?.code ?? result.body?.data?.[field]?.error?.code;
  if (code === "UNAUTHENTICATED") return "unauthenticated";
  if (code) return "denied";
  return result.body?.data?.[field]?.data ? "ok" : "denied";
}

const read = async (credential: string) =>
  outcome(await graphql("{ relations(first: 1) { data { totalCount } error { code } } }", credential), "relations");

async function write(credential: string, name = `pk-${randomUUID().slice(0, 8)}`): Promise<{ access: Access; id?: string }> {
  const result = await graphql(
    `mutation { createRelation(input: { displayName: "${name}", relationType: "person" }) { data { id } error { code } } }`,
    credential,
  );
  return { access: outcome(result, "createRelation"), id: result.body?.data?.createRelation?.data?.id };
}

/** Resolver caches (the 30-second owner-account cache) — so a realm change shows on the next request. */
const fresh = () => __resetSessionResolverForTests();

describe.skipIf(!ready)("personal API keys end to end", () => {
  test("the owner mints a key and gets the secret exactly once", async () => {
    const created = await op("mine/create", { displayName: "laptop script" }, ownerToken);
    expect(created.status).toBe(200);
    expect(created.headers["cache-control"]).toContain("no-store");
    expect(created.body.credential.secret).toStartWith("osf_user_");
    expect(created.body.key.status).toBe("active");
    expect(created.body.key.roleSubset).toBeNull();
    const days = (Date.parse(created.body.key.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);

    const listed = await op("mine/list", {}, ownerToken);
    expect(listed.status).toBe(200);
    const row = listed.body.keys.find((key: { id: string }) => key.id === created.body.credential.id);
    expect(row).toBeDefined();
    expect(JSON.stringify(listed.body)).not.toContain(created.body.credential.secret);
  });

  test("the key acts as its owner: same rights, and the audit trail names the person", async () => {
    const key = await mint({});
    expect(await read(key.secret)).toBe("ok");
    const created = await write(key.secret);
    expect(created.access).toBe("ok");

    const event = await withSystemSession(
      seed!.db,
      { actorSubject: "e2e-check", roles: [SYSTEM_BYPASS_ROLE], reason: "e2e: read audit", tenantId },
      (trx) => sql<{ payload: { audit?: { actorSubject?: string; actorKind?: string } } }>`
        select payload from platform.entity_events
         where tenant_id = ${tenantId} and aggregate_id = ${created.id!}
         order by occurred_at desc limit 1`.execute(trx),
    );
    expect(event.rows[0]?.payload.audit?.actorSubject).toBe(ownerRealmId);
    expect(event.rows[0]?.payload.audit?.actorKind).toBe("person");
  });

  test("a key carries the owner's CURRENT roles: withdraw one and the key loses it", async () => {
    const key = await mint({});
    expect((await write(key.secret)).access).toBe("ok");
    await setMembershipRoles(ownerToken!, ["Platform.ApiKeys.Personal", "Relations.All.Read"]);
    try {
      expect((await write(key.secret)).access).toBe("denied");
      expect(await read(key.secret)).toBe("ok");
    } finally {
      await setMembershipRoles(ownerToken!, OWNER_ROLES);
    }
    expect((await write(key.secret)).access).toBe("ok");
  });

  test("a narrowing narrows, and cannot reach past what the owner holds", async () => {
    const narrow = await mint({ roleSubset: ["Relations.All.Read"] });
    expect(await read(narrow.secret)).toBe("ok");
    expect((await write(narrow.secret)).access).toBe("denied");

    const widen = await op("mine/create", { displayName: "too wide", roleSubset: ["Finance.All.ReadWrite"] }, ownerToken);
    expect(widen.status).toBe(403);
  });

  test("an IP allowlist fences the key to its networks, and no browser may present it", async () => {
    const created = await op("mine/create", { displayName: "fenced script", allowedIps: ["203.0.113.0/24", "2001:db8::/32"] }, ownerToken);
    expect(created.status).toBe(200);
    expect(created.body.key.allowedIps).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
    const secret = created.body.credential.secret as string;
    const rest = (headers: Record<string, string>) => app!.inject({
      method: "GET",
      url: "/api/rest/v1/relations",
      headers: { authorization: `Bearer ${secret}`, ...headers },
    });
    const code = (response: { body: string }) => (JSON.parse(response.body) as { error?: { code?: string } }).error?.code;

    // The test client's own address (127.0.0.1) is not on the list.
    const outside = await rest({});
    expect(outside.statusCode).toBe(403);
    expect(code(outside)).toBe("API_KEY_RESTRICTED");
    // A client cannot claim an address by naming the server's own header.
    const forged = await rest({ "x-openshapeforge-client-address": "203.0.113.5" });
    expect(forged.statusCode).toBe(403);
    // Through the one trusted proxy hop, a listed address is admitted.
    expect((await rest({ "x-forwarded-for": "203.0.113.5" })).statusCode).toBe(200);
    expect((await rest({ "x-forwarded-for": "2001:db8::7" })).statusCode).toBe(200);
    // Only the hop the API trusts counts: an address a client prepends does not.
    expect((await rest({ "x-forwarded-for": "203.0.113.5, 192.0.2.1" })).statusCode).toBe(403);
    // From a listed network, but presented by a browser: a personal key never works there.
    const browser = await rest({ "x-forwarded-for": "203.0.113.5", origin: "https://shop.example.com" });
    expect(browser.statusCode).toBe(403);
    expect(code(browser)).toBe("API_KEY_RESTRICTED");
    expect(browser.headers["access-control-allow-origin"]).toBeUndefined();

    const listed = await op("mine/list", {}, ownerToken);
    const row = listed.body.keys.find((key: { id: string }) => key.id === created.body.credential.id);
    expect(row.allowedIps).toEqual(["203.0.113.0/24", "2001:db8::/32"]);

    const invalid = await op("mine/create", { displayName: "bad fence", allowedIps: ["example.com"] }, ownerToken);
    expect(invalid.status).toBe(400);
  });

  test("a lifetime past 90 days is refused", async () => {
    const tooLong = await op("mine/create", { displayName: "forever", expiresInDays: 365 }, ownerToken);
    expect(tooLong.status).toBe(400);
  });

  test("no API key can manage API keys — not even its owner's own", async () => {
    const key = await mint({});
    for (const [path, body] of [
      ["mine/create", { displayName: "ladder" }],
      ["mine/list", {}],
      ["mine/revoke", { id: key.id }],
      ["list", {}],
    ] as const) {
      const result = await op(path, body, key.secret);
      expect(result.status).toBe(403);
    }
  });

  test("only the owner sees their keys; a colleague without oversight sees nothing", async () => {
    const key = await mint({});
    const colleagueMine = await op("mine/list", {}, colleagueToken);
    expect(colleagueMine.status).toBe(200);
    expect(colleagueMine.body.keys.some((row: { id: string }) => row.id === key.id)).toBe(false);
    expect((await op("mine/get", { id: key.id }, colleagueToken)).status).toBe(404);
    expect((await op("mine/revoke", { id: key.id }, colleagueToken)).status).toBe(404);
    expect((await op("list", {}, colleagueToken)).status).toBe(403);
    expect((await op("revoke", { id: key.id }, colleagueToken)).status).toBe(403);
    expect(await read(key.secret)).toBe("ok");
  });

  test("row-level security alone keeps another person's key out of reach", async () => {
    const key = await mint({});
    // As the restricted runtime role, which RLS binds; the migrate owner the
    // seed uses may bypass it and would prove nothing.
    const runtime = createDatabaseRuntime({ databaseUrl: DATABASE_URL });
    try {
      const count = (userId: string, roles: string[]) => withDbSession(
        runtime.db,
        { tenantId, userId, roles, groups: [], scope: "tenant", principalKind: "person" },
        (trx) => sql<{ n: number }>`select count(*)::int as n from platform.personal_api_keys where id = ${key.id}`.execute(trx),
      ).then((result) => result.rows[0]?.n);
      expect(await count(claims(colleagueToken!).sub, ["Platform.ApiKeys.Personal"])).toBe(0);
      expect(await count(ownerRealmId!, ["Platform.ApiKeys.Personal"])).toBe(1);
      expect(await count(claims(colleagueToken!).sub, ["Platform.ApiKeys.PersonalRead"])).toBe(1);
      // And a colleague cannot revoke it through raw SQL either.
      const changed = await withDbSession(
        runtime.db,
        { tenantId, userId: claims(colleagueToken!).sub, roles: ["Platform.ApiKeys.Personal"], groups: [], scope: "tenant", principalKind: "person" },
        (trx) => sql`update platform.personal_api_keys set revoked_at = now() where id = ${key.id}`.execute(trx),
      );
      expect(Number(changed.numAffectedRows ?? 0)).toBe(0);
    } finally {
      await runtime.close();
    }
    expect(await read(key.secret)).toBe("ok");
  });

  test("an administrator sees everyone's keys as metadata, and can revoke one the owner then sees", async () => {
    const key = await mint({ displayName: "admin will revoke this" });
    const overview = await op("list", { ownerUserId: ownerRealmId }, adminToken);
    expect(overview.status).toBe(200);
    const row = overview.body.keys.find((entry: { id: string }) => entry.id === key.id);
    expect(row?.ownerUserId).toBe(ownerRealmId);
    expect(row?.ownerName).toBeTruthy();
    expect(JSON.stringify(overview.body)).not.toContain(key.secret);
    expect(Object.keys(row)).not.toContain("secret");

    // Not in the administrator's OWN list: oversight is a separate view.
    const adminMine = await op("mine/list", {}, adminToken);
    expect(adminMine.body.keys.some((entry: { id: string }) => entry.id === key.id)).toBe(false);

    expect(await read(key.secret)).toBe("ok");
    const revoked = await op("revoke", { id: key.id }, adminToken);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("revoked");
    expect(await read(key.secret)).toBe("unauthenticated");

    const ownerView = await op("mine/get", { id: key.id }, ownerToken);
    expect(ownerView.body.status).toBe("revoked");
    expect(ownerView.body.revokedByAdministrator).toBe(true);

    const events = await withSystemSession(
      seed!.db,
      { actorSubject: "e2e-check", roles: [SYSTEM_BYPASS_ROLE], reason: "e2e: read audit", tenantId },
      (trx) => sql<{ event_type: string; payload: { actorUserId?: string; ownerUserId?: string } }>`
        select event_type, payload from platform.entity_events
         where tenant_id = ${tenantId} and aggregate_type = 'PersonalApiKey' and aggregate_id = ${key.id}
         order by occurred_at`.execute(trx),
    );
    const revocation = events.rows.find((event) => event.event_type === "personal_api_key_revoked_by_administrator");
    expect(revocation?.payload.actorUserId).toBe(claims(adminToken!).sub);
    expect(revocation?.payload.ownerUserId).toBe(ownerRealmId);
  });

  test("an administrator of another organization neither sees nor revokes this one's keys", async () => {
    const key = await mint({});
    const overview = await op("list", {}, otherTenantToken);
    expect(overview.status).toBe(200);
    expect(overview.body.keys.some((entry: { id: string }) => entry.id === key.id)).toBe(false);
    expect((await op("get", { id: key.id }, otherTenantToken)).status).toBe(404);
    expect((await op("revoke", { id: key.id }, otherTenantToken)).status).toBe(404);
    expect(await read(key.secret)).toBe("ok");
  });

  test("the owner revokes their own key, and it stops at once", async () => {
    const key = await mint({});
    expect(await read(key.secret)).toBe("ok");
    const revoked = await op("mine/revoke", { id: key.id }, ownerToken);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedByAdministrator).toBe(false);
    expect(await read(key.secret)).toBe("unauthenticated");
    // Idempotent.
    const again = await op("mine/revoke", { id: key.id }, ownerToken);
    expect(again.body.revokedAt).toBe(revoked.body.revokedAt);
  });

  test("a blocked membership stops every key of the owner", async () => {
    const key = await mint({});
    expect(await read(key.secret)).toBe("ok");
    await setOwnerBlocked(true);
    try {
      expect(await read(key.secret)).not.toBe("ok");
    } finally {
      await setOwnerBlocked(false);
    }
    expect(await read(key.secret)).toBe("ok");
  });

  test("a disabled realm account stops every key of the owner", async () => {
    const key = await mint({});
    expect(await read(key.secret)).toBe("ok");
    await setOwnerEnabled(false);
    fresh();
    try {
      expect(await read(key.secret)).toBe("unauthenticated");
    } finally {
      await setOwnerEnabled(true);
      fresh();
    }
    expect(await read(key.secret)).toBe("ok");
  });

  test("an expired key and a forged one authenticate nothing", async () => {
    const key = await mint({ expiresInDays: 1 });
    expect(await read(key.secret)).toBe("ok");
    await withSystemSession(
      seed!.db,
      { actorSubject: "e2e-seed", roles: [SYSTEM_BYPASS_ROLE], reason: "e2e: expire a key", tenantId },
      (trx) => sql`update platform.personal_api_keys set expires_at = now() - interval '1 minute' where id = ${key.id}`.execute(trx),
    );
    expect(await read(key.secret)).toBe("unauthenticated");
    expect(await read(`${key.secret.slice(0, -1)}${key.secret.endsWith("A") ? "B" : "A"}`)).toBe("unauthenticated");
    expect(await read(key.secret.replace("osf_user_", "osf_live_"))).toBe("unauthenticated");
  });
});
