// SPDX-License-Identifier: BUSL-1.1
/**
 * The integration catalog through the ACTUAL canonical Operation dispatcher,
 * against a real PostgreSQL, as a verified person who has a Relation.
 *
 * Every other suite for this feature either calls a handler directly or drives
 * the older REST/GraphQL mounts. Neither can see the failure this file is
 * about. A writing canonical Operation is dispatched inside
 * `withModuleOperationTransaction` — core opens a database session for the
 * session it verified, carrying the identity link, the audit identity and the
 * access scope the resolver resolved — and the provisioning service then
 * opened a second one from the handful of fields it holds. `withDbSession`
 * refuses that substitution by design, so the whole catalog's writes failed
 * for exactly the caller who is supposed to use them: a logged-in
 * administrator whose login is linked to a Relation.
 *
 * What is proven here, and how:
 *
 *   - the four writing Operations and the reads succeed over the booted HTTP
 *     dispatcher under a signed in-mesh bundle for a person with a Relation;
 *   - the service's rows are written by the DISPATCHER's transaction, shown by
 *     comparing each row's `xmin` against that transaction's own `txid_current()`
 *     — not inferred from the call having returned;
 *   - a failure after the handler discards those rows WITH the caller's
 *     transaction, while the 'pending' intent row survives, because that row
 *     is what reconcile.ts needs to find an orphaned realm client;
 *   - a realm that refuses leaves a 'pending' row, no credential, and a
 *     declared 502 rather than an internal error;
 *   - a malformed cursor is a declared 400 before any value reaches a cast,
 *     while a cursor this listing issued still walks a date-sorted page.
 *
 * The only doubles are the realm (a real HTTP server speaking the slice of the
 * Keycloak Admin API the provisioning path calls) and the clock. The database,
 * the session layer, the dispatcher and the routes are the shipped ones.
 *
 * Skips wholesale when no PostgreSQL is reachable, so it never fails for the
 * wrong reason; point `SCRATCH_ADMIN_DATABASE_URL` at an isolated server.
 */
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { API_KEY_MANAGE_ROLE } from "../auth/api-key/ceiling.js";
import {
  createIntegration,
  issueKey,
  pageIntegrations,
  revokeKey,
  type ApiKeyServiceDeps,
  type ProvisioningSession,
} from "../auth/api-key/service.js";
import { stubRealm, type StubRealm } from "../auth/api-key/__tests__/fixtures.js";
import { readApiKeyProvisioningConfig } from "../auth/api-key/runtime-config.js";
import { createDatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { withDbSession } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { DB } from "../generated/db/types.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 180_000;

const TENANT = randomUUID();
const MANAGER = randomUUID();
const IDENTITY = randomUUID();
const RELATION = randomUUID();
const READ_ROLE = "Relations.All.Read";
const ISSUER = "https://identity.test/realms/openshapeforge";

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function serverReachable(): Promise<boolean> {
  const probe = new SQL(ADMIN_URL, { max: 1 });
  try {
    await probe.unsafe("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

/**
 * The session core verifies for this person, as the dispatcher opens it.
 *
 * The three fields the service used to drop are all here and all non-empty:
 * the identity link (`relation`, which `verifiedAuditIdentity` turns into the
 * audit identity and `actingRelationId` into `app.relation_id`) and the access
 * scope, which for a trusted-context person with no org units resolves to
 * "self" — NOT the "tenant" the service used to assume.
 */
function verifiedPersonSession(): TrustedSessionContext {
  return {
    tenantId: TENANT,
    userId: MANAGER,
    issuer: ISSUER,
    roles: [API_KEY_MANAGE_ROLE, READ_ROLE],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "trusted-context",
    principalKind: "person",
    relation: {
      identityId: IDENTITY,
      issuer: ISSUER,
      subject: MANAGER,
      status: "linked",
      roles: [],
      relationId: RELATION,
      displayName: "Alex Manager",
      relationType: "person",
      candidateRelationId: null,
      linkedBy: "test",
      needsRoleAssignment: false,
    },
  };
}

/** The ceiling's view of the same person; what a handler hands the service. */
function provisioningSession(): ProvisioningSession {
  const session = verifiedPersonSession();
  return {
    tenantId: TENANT,
    userId: MANAGER,
    roles: session.roles,
    groups: session.groups,
    credential: session.credential,
    principalKind: "person",
  };
}

type Booted = {
  app: Awaited<ReturnType<typeof import("../roles/api.js").createApiApp>>;
  appDb: Kysely<DB>;
  adminDb: Kysely<DB>;
  deps: ApiKeyServiceDeps;
  close: () => Promise<void>;
};

let booted: Booted | null = null;
let realm: StubRealm;
let databaseName = "";
let server: SQL | null = null;

/** The hop apps/web signs for a logged-in administrator of this tenant. */
function managerHeaders(): Record<string, string> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, {
    tenantId: TENANT,
    userId: MANAGER,
    roles: [API_KEY_MANAGE_ROLE, READ_ROLE],
    principalKind: "person",
  }, { secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET! });
  return Object.fromEntries(headers.entries());
}

/** The paths whose contract declares an acknowledgement. */
const ACKNOWLEDGED = new Set(["create", "issue-credential", "revoke-credential", "disable"]);

/** One canonical Operation over its declared REST projection. */
async function operation(path: string, input: Record<string, unknown>) {
  const response = await booted!.app.inject({
    method: "POST",
    url: `/api/api-key-integrations/${path}`,
    headers: managerHeaders(),
    // `confirmed` belongs only to the acknowledged contracts; a read's input
    // schema forbids additional properties and would refuse it.
    payload: JSON.stringify(ACKNOWLEDGED.has(path) ? { confirmed: true, ...input } : input),
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, any> };
}

beforeAll(async () => {
  if (!(await serverReachable())) {
    console.log(
      `[api-key dispatcher] SKIPPED — no PostgreSQL at ${new URL(ADMIN_URL).host}. ` +
        "Set SCRATCH_ADMIN_DATABASE_URL to an isolated server to run this suite.",
    );
    return;
  }
  realm = stubRealm({ roles: [READ_ROLE] });
  databaseName = `api_key_dispatcher_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${databaseName}"`);
  const admin = createDatabaseRuntime({ databaseUrl: databaseUrl(databaseName), maxConnections: 4 });
  await admin.db.connection().execute((trx) => runMigrationChain(trx));

  // A tenant, a Relation, and the login linked to it. The link is the whole
  // point: it is what gives the verified session an audit identity and an
  // acting Relation, and therefore what the service's rebuilt session could
  // never reproduce.
  await admin.db.connection().execute(async (trx) => {
    await sql`
      insert into platform.tenants (id, slug, name, status, keycloak_realm)
      values (${TENANT}, 'dispatcher', 'Dispatcher', 'active', 'openshapeforge')
    `.execute(trx);
    await sql`
      insert into erp.relations (id, tenant_id, display_name, relation_type, status)
      values (${RELATION}, ${TENANT}, 'Alex Manager', 'person', 'active')
    `.execute(trx);
    await sql`
      insert into platform.identities (id, issuer, subject, display_name)
      values (${IDENTITY}, ${ISSUER}, ${MANAGER}, 'Alex Manager')
    `.execute(trx);
    await sql`
      insert into platform.identity_relations
        (identity_id, tenant_id, relation_id, status, linked_at, linked_by)
      values (${IDENTITY}, ${TENANT}, ${RELATION}, 'linked', now(), 'test')
    `.execute(trx);
  });

  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??= "dispatcher-suite-context-secret";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
  process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS = `test:${randomBytes(32).toString("base64")}`;
  process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = realm.baseUrl;
  process.env.OPENSHAPEFORGE_KEYCLOAK_REALM = realm.realm;
  process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID = "provisioner";
  process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET = "provisioner-secret";
  process.env.API_RATE_LIMIT_MAX ??= "100000";
  process.env.API_RATE_LIMIT_MAX_TRUSTED ??= "100000";

  const { createApiApp } = await import("../roles/api.js");
  const { __resetSessionResolverForTests } = await import("../auth/identity.js");
  __resetSessionResolverForTests();
  const app = createApiApp({
    cors: false,
    databaseUrl: databaseUrl(databaseName, true),
    logStream: { write: () => {} },
  });
  await app.ready();

  // A second handle on the same restricted role, for the transaction-identity
  // tests: they need to BE the dispatcher's transaction rather than observe it.
  const appRuntime = createDatabaseRuntime({
    databaseUrl: databaseUrl(databaseName, true),
    maxConnections: 6,
  });
  // The same configuration the handler resolves, from the same environment, so
  // the service under test is wired exactly as the dispatcher wires it.
  const config = readApiKeyProvisioningConfig()!;
  booted = {
    app,
    appDb: appRuntime.db,
    adminDb: admin.db,
    deps: {
      db: appRuntime.db,
      keyring: config.keyring,
      admin: config.admin,
      entityRoleClientId: config.entityRoleClientId,
      lifetime: config.lifetime,
    },
    close: async () => {
      await app.close();
      await appRuntime.close();
      await admin.close();
    },
  };
}, TEST_TIMEOUT);

afterAll(async () => {
  await booted?.close();
  if (realm) await realm.stop();
  if (server) {
    if (databaseName) await server.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await server.close();
  }
}, TEST_TIMEOUT);

describe("the catalog over the real dispatcher, as a person with a Relation", () => {
  test("creates, issues, revokes and disables, and reads its own pages", async () => {
    if (!booted) return;
    const created = await operation("create", {
      displayName: "Partner portal", roles: [READ_ROLE], expiresInDays: 30,
    });
    expect(created).toMatchObject({ status: 200 });
    const integrationId = created.body.integration?.integrationId as string;
    expect(created.body).toMatchObject({
      integration: {
        integrationId: expect.any(String),
        displayName: "Partner portal",
        status: "active",
        grantedRoles: [READ_ROLE],
      },
      credential: { id: expect.any(String), secret: expect.any(String) },
    });

    // The row is really there, under this tenant, as the service wrote it.
    const stored = await sql<{ status: string; created_by: string }>`
      select status, created_by::text as created_by
        from platform.api_key_integrations
       where id = ${integrationId}::uuid and tenant_id = ${TENANT}::uuid
    `.execute(booted.adminDb);
    expect(stored.rows[0]).toMatchObject({ status: "active", created_by: MANAGER });

    const listed = await operation("list", { first: 10 });
    expect(listed.status).toBe(200);
    expect(listed.body.integrations).toHaveLength(1);
    expect(listed.body.totalCount).toBe(1);

    const issued = await operation("issue-credential", {
      integrationId, displayName: "Rotation", expiresInDays: 30,
    });
    expect(issued).toMatchObject({ status: 200 });
    expect(issued.body.credential?.secret).toBeTypeOf("string");

    const credentials = await operation("list-credentials", { integrationId, first: 10 });
    expect(credentials.status).toBe(200);
    expect(credentials.body.credentials).toHaveLength(2);

    const revoked = await operation("revoke-credential", { id: issued.body.credential.id });
    expect(revoked).toMatchObject({ status: 200, body: { status: "revoked" } });

    const disabled = await operation("disable", { integrationId });
    expect(disabled).toMatchObject({
      status: 200, body: { status: "disabled", revokedCredentials: 1 },
    });
  }, TEST_TIMEOUT);

  test("refuses a malformed cursor as a declared 400, not a server error", async () => {
    if (!booted) return;
    // A cursor is opaque but not trusted: its id reaches a uuid column and its
    // value a timestamptz cast, so a crafted one used to be a 500 from
    // PostgreSQL rather than the 400 this contract declares. The fingerprint
    // is public — it is derived from the sort and the filters — so a caller
    // can produce a cursor that passes every check except the value's shape.
    const forge = (payload: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const { createHash } = await import("node:crypto");
    const fingerprint = (parts: readonly (string | undefined)[]) =>
      createHash("sha256").update(JSON.stringify(parts.map((part) => part ?? null)))
        .digest("base64url").slice(0, 16);

    const cases: { path: string; input: Record<string, unknown>; label: string }[] = [
      {
        label: "an id that is not a UUID",
        path: "list",
        input: {
          sortField: "displayName", sortDirection: "asc",
          after: forge({
            f: "displayName", d: "asc", q: fingerprint(["integrations", undefined, undefined]),
            v: "partner portal", i: "not-a-uuid",
          }),
        },
      },
      {
        label: "a sort value that is not a timestamp",
        path: "list",
        input: {
          sortField: "createdAt", sortDirection: "desc",
          after: forge({
            f: "createdAt", d: "desc", q: fingerprint(["integrations", undefined, undefined]),
            v: "yesterday", i: randomUUID(),
          }),
        },
      },
      {
        label: "a sort value that is a timestamp with something appended",
        path: "list",
        input: {
          sortField: "createdAt", sortDirection: "asc",
          after: forge({
            f: "createdAt", d: "asc", q: fingerprint(["integrations", undefined, undefined]),
            v: "2026-01-02 00:00:00+00'); select 1 --", i: randomUUID(),
          }),
        },
      },
    ];

    for (const scenario of cases) {
      const response = await operation(scenario.path, scenario.input);
      expect({ label: scenario.label, status: response.status, code: response.body.error?.code })
        .toEqual({ label: scenario.label, status: 400, code: "VALIDATION" });
    }
  }, TEST_TIMEOUT);

  test("pages a date sort with the cursors it issued, end to end", async () => {
    if (!booted) return;
    // The shape check on a cursor's sort value only earns its place if a real
    // one still passes it. These resume on `createdAt` — a timestamptz, so the
    // value is rendered by the database and cast back by it — one row at a
    // time, over the dispatcher, until the listing says there is no more.
    const names = new Set<string>();
    for (const name of ["Alpha partner", "Beta partner", "Gamma partner"]) {
      expect((await operation("create", {
        displayName: name, roles: [READ_ROLE], expiresInDays: 30,
      })).status).toBe(200);
    }
    let after: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const response = await operation("list", {
        sortField: "createdAt", sortDirection: "asc", first: 1,
        ...(after === undefined ? {} : { after }),
      });
      expect({ page, status: response.status }).toEqual({ page, status: 200 });
      for (const row of response.body.integrations as { displayName: string }[]) {
        names.add(row.displayName);
      }
      after = response.body.nextCursor ?? undefined;
      if (!after) break;
    }
    expect(after).toBeUndefined();
    for (const name of ["Alpha partner", "Beta partner", "Gamma partner"]) {
      expect(names).toContain(name);
    }
  }, TEST_TIMEOUT);
});

describe("the service's writes belong to the dispatcher's transaction", () => {
  test("the credential row is written by the caller's own transaction", async () => {
    if (!booted) return;
    // `xmin` is the transaction that inserted the row. Comparing it against
    // the outer transaction's `txid_current()` is the only way to show the
    // write JOINED rather than committed next door — a call that returned
    // successfully would look identical either way.
    const observed = await withDbSession(
      booted.appDb,
      verifiedPersonSession(),
      async (trx) => {
        const outer = (await sql<{ txid: string }>`select txid_current()::text as txid`
          .execute(trx)).rows[0]!.txid;
        const created = await createIntegration(booted!.deps, provisioningSession(), {
          displayName: "Joined write", roles: [READ_ROLE], expiresInDays: 30,
        });
        const key = (await sql<{ xmin: string }>`
          select xmin::text as xmin from platform.api_keys where id = ${created.keyId}::uuid
        `.execute(trx)).rows[0]!.xmin;
        // The INTENT row was committed by its own transaction BEFORE the realm
        // was touched: another connection can already see it while this
        // transaction is still open. Without that, a crash in the realm step
        // would leave a client no 'pending' row names, and reconcile.ts could
        // neither finish nor sweep it. (Its `xmin` is this transaction's by
        // now — step 3 updated the row here — so visibility is the property to
        // check, not the row version.)
        const visibleElsewhere = (await sql<{ status: string }>`
          select status from platform.api_key_integrations
           where id = ${created.integrationId}::uuid
        `.execute(booted!.adminDb)).rows[0]?.status;
        // The GUCs the dispatcher's session established are still the ones in
        // force, so the service did not replace the session it joined.
        const settings = (await sql<{ relation: string; audit: string; scope: string }>`
          select current_setting('app.relation_id') as relation,
                 current_setting('app.audit_identity_id') as audit,
                 current_setting('app.scope') as scope
        `.execute(trx)).rows[0]!;
        return { outer, key, visibleElsewhere, settings, created };
      },
    );

    expect(observed.key).toBe(observed.outer);
    expect(observed.settings).toEqual({
      relation: RELATION, audit: IDENTITY, scope: "self",
    });
    expect(observed.visibleElsewhere).toBe("pending");
  }, TEST_TIMEOUT);

  test("a failure after the handler discards the credential but keeps the intent", async () => {
    if (!booted) return;
    let created: { integrationId: string; keyId: string } | undefined;
    await expect(withDbSession(booted.appDb, verifiedPersonSession(), async () => {
      created = await createIntegration(booted!.deps, provisioningSession(), {
        displayName: "Rolled back", roles: [READ_ROLE], expiresInDays: 30,
      });
      throw new Error("the Operation failed after its handler returned");
    })).rejects.toThrow("the Operation failed after its handler returned");

    const key = await sql<{ id: string }>`
      select id from platform.api_keys where id = ${created!.keyId}::uuid
    `.execute(booted.adminDb);
    expect(key.rows).toEqual([]);
    const integration = await sql<{ status: string }>`
      select status from platform.api_key_integrations
       where id = ${created!.integrationId}::uuid
    `.execute(booted.adminDb);
    expect(integration.rows[0]?.status).toBe("pending");
  }, TEST_TIMEOUT);

  test("reads and the other writes join the same transaction too", async () => {
    if (!booted) return;
    // One transaction, every remaining Operation of the catalog in it: a fix
    // that only covered `createIntegration` would pass the tests above and
    // still fail the first administrator who tried to rotate a credential.
    const result = await withDbSession(
      booted.appDb,
      verifiedPersonSession(),
      async (trx) => {
        const outer = (await sql<{ txid: string }>`select txid_current()::text as txid`
          .execute(trx)).rows[0]!.txid;
        const created = await createIntegration(booted!.deps, provisioningSession(), {
          displayName: "Nested rotation", roles: [READ_ROLE], expiresInDays: 30,
        });
        const issued = await issueKey(booted!.deps, provisioningSession(), {
          integrationId: created.integrationId, displayName: "Rotation", expiresInDays: 30,
        });
        const revoked = await revokeKey(booted!.deps, provisioningSession(), issued.keyId);
        const page = await pageIntegrations(booted!.deps, provisioningSession(), {
          sortField: "createdAt", sortDirection: "desc", first: 5,
        });
        const issuedXmin = (await sql<{ xmin: string }>`
          select xmin::text as xmin from platform.api_keys where id = ${issued.keyId}::uuid
        `.execute(trx)).rows[0]!.xmin;
        return { outer, issuedXmin, revoked, names: page.rows.map((row) => row.displayName) };
      },
    );
    expect(result.issuedXmin).toBe(result.outer);
    expect(result.revoked.revokedAt).toBeInstanceOf(Date);
    expect(result.names).toContain("Nested rotation");
  }, TEST_TIMEOUT);

  test("refuses to join a database session that belongs to another principal", async () => {
    if (!booted) return;
    // The joined session is never an authorization source. A service call that
    // arrived with a different verified session than the transaction it finds
    // is this service's bug, and it fails rather than running either
    // principal's statements under the other's session.
    const stranger = { ...provisioningSession(), userId: randomUUID() };
    await expect(withDbSession(booted.appDb, verifiedPersonSession(), () =>
      pageIntegrations(booted!.deps, stranger, {
        sortField: "createdAt", sortDirection: "desc", first: 5,
      }))).rejects.toThrow("another principal's database session");
  }, TEST_TIMEOUT);
});

describe("a realm that refuses", () => {
  test("leaves a sweepable intent row, no credential, and a declared 502", async () => {
    if (!booted) return;
    // The stub realm grants only READ_ROLE, so asking for the management role
    // — which this caller DOES hold, so the ceiling admits it — fails in the
    // realm AFTER the client was created. That is the exact crash window the
    // 'pending' row exists for: a realm client with no active integration.
    const response = await operation("create", {
      displayName: "Realm is down", roles: [API_KEY_MANAGE_ROLE], expiresInDays: 30,
    });
    expect({ status: response.status, code: response.body.error?.code })
      .toEqual({ status: 502, code: "PROVISIONING_FAILED" });

    const pending = await sql<{ id: string; keycloak_client_id: string; keys: string }>`
      select i.id::text as id, i.keycloak_client_id,
             (select count(*) from platform.api_keys k where k.integration_id = i.id)::text as keys
        from platform.api_key_integrations i
       where i.tenant_id = ${TENANT}::uuid
         and i.display_name = 'Realm is down'
         and i.status = 'pending'
    `.execute(booted.adminDb);
    // Exactly what reconcile.ts sweeps: one row, its derived client id, and no
    // credential anyone was handed.
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]!.keycloak_client_id).toStartWith("osf-int-");
    expect(pending.rows[0]!.keys).toBe("0");
  }, TEST_TIMEOUT);

  test("keeps the intent durable when the realm fails inside a dispatcher transaction", async () => {
    if (!booted) return;
    // The same realm failure, nested in a caller's transaction, and then that
    // transaction rolls back too. The 'pending' row still has to be there: it
    // names the realm client the failed step may already have created, and it
    // is the only thing reconcile.ts has to find it by.
    const before = realm.requests.filter((entry) => entry === "POST /admin/realms/openshapeforge/clients").length;
    await expect(withDbSession(booted.appDb, verifiedPersonSession(), async () => {
      await createIntegration(booted!.deps, provisioningSession(), {
        displayName: "Realm down, caller rolled back",
        roles: [API_KEY_MANAGE_ROLE],
        expiresInDays: 30,
      });
    })).rejects.toThrow(/Could not provision the identity/);

    const rows = await sql<{ status: string; keys: string }>`
      select i.status,
             (select count(*) from platform.api_keys k where k.integration_id = i.id)::text as keys
        from platform.api_key_integrations i
       where i.tenant_id = ${TENANT}::uuid
         and i.display_name = 'Realm down, caller rolled back'
    `.execute(booted.adminDb);
    expect(rows.rows).toEqual([{ status: "pending", keys: "0" }]);
    // One attempt, one realm client: the failure is not retried behind the
    // caller's back, so nothing is provisioned twice.
    const after = realm.requests.filter((entry) => entry === "POST /admin/realms/openshapeforge/clients").length;
    expect(after - before).toBe(1);
  }, TEST_TIMEOUT);
});
