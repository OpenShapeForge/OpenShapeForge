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
 *   - an impossible cursor is a declared 400 before any value reaches a cast —
 *     including a value shaped exactly as the column renders, which only the
 *     calendar can refuse — on both listings and in both directions, while the
 *     cursors these listings issue still walk every sort to its end.
 *
 * The only doubles are the realm (a real HTTP server speaking the slice of the
 * Keycloak Admin API the provisioning path calls) and the clock. The database,
 * the session layer, the dispatcher and the routes are the shipped ones.
 *
 * Skips wholesale when no PostgreSQL is reachable, so it never fails for the
 * wrong reason; point `SCRATCH_ADMIN_DATABASE_URL` at an isolated server.
 */
import { applyTrustedContextHeaders, TRUSTED_CONTEXT_HEADERS } from "@openshapeforge/auth";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { API_KEY_MANAGE_ROLE } from "../auth/api-key/ceiling.js";
import {
  createIntegration,
  issueKey,
  listKeys,
  pageIntegrations,
  revokeKey,
  MAX_DISPLAY_NAME_LENGTH,
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
const OTHER_TENANT = randomUUID();
const MANAGER = randomUUID();
/**
 * A second administrator of the same tenant whose login is linked to NOTHING.
 *
 * Not every person has a Relation — a platform-side administrator, a newly
 * invited colleague before confirmation — and such a session has no identity
 * link to read, so the only thing that can classify it is the verdict its
 * signer put inside the HMAC. See the suite for principal classes below.
 */
const UNLINKED_MANAGER = randomUUID();
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
  return signedHop({ userId: MANAGER, principalKind: "person" });
}

/**
 * The current (payload v3) in-mesh hop, signed as a producer would sign it.
 *
 * `principalKind` goes INSIDE the signature, so a caller cannot add, change or
 * remove it — which is what the forged-class case below relies on.
 */
function signedHop(input: {
  userId: string;
  tenantId?: string;
  roles?: readonly string[];
  principalKind?: "person" | "service";
}): Record<string, string> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, {
    tenantId: input.tenantId ?? TENANT,
    userId: input.userId,
    roles: [...(input.roles ?? [API_KEY_MANAGE_ROLE, READ_ROLE])],
    ...(input.principalKind ? { principalKind: input.principalKind } : {}),
  }, { secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET! });
  return Object.fromEntries(headers.entries());
}

/**
 * The producer that shipped BEFORE the class was signed, verbatim.
 *
 * Six payload fields and no principal class — reproduced rather than asked of
 * the current package, because asking the current package to sign v2 would
 * prove the current package agrees with itself. This is the wire format a tier
 * that has not been redeployed still emits, and it must keep doing ordinary
 * work (packages/auth ACCEPTED_PAYLOAD_VERSIONS).
 */
function unclassifiedV2Hop(userId = MANAGER): Record<string, string> {
  const roles = [API_KEY_MANAGE_ROLE, READ_ROLE].join(",");
  const timestamp = String(Date.now());
  const payload = ["v2", timestamp, TENANT, userId, roles, ""].join("\n");
  return {
    "content-type": "application/json",
    [TRUSTED_CONTEXT_HEADERS.tenantId]: TENANT,
    [TRUSTED_CONTEXT_HEADERS.userId]: userId,
    [TRUSTED_CONTEXT_HEADERS.roles]: roles,
    [TRUSTED_CONTEXT_HEADERS.groups]: "",
    [TRUSTED_CONTEXT_HEADERS.timestamp]: timestamp,
    [TRUSTED_CONTEXT_HEADERS.signature]: createHmac(
      "sha256",
      process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET!,
    ).update(payload).digest("hex"),
  };
}

/** The paths whose contract declares an acknowledgement. */
const ACKNOWLEDGED = new Set(["create", "issue-credential", "revoke-credential", "disable"]);

/** One canonical Operation over its declared REST projection. */
async function operation(
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = managerHeaders(),
) {
  const response = await booted!.app.inject({
    method: "POST",
    url: `/api/api-key-integrations/${path}`,
    headers,
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
      values (${TENANT}, 'dispatcher', 'Dispatcher', 'active', 'openshapeforge'),
             (${OTHER_TENANT}, 'neighbour', 'Neighbour', 'active', 'openshapeforge')
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

  test("refuses an impossible cursor as a declared 400 on both listings, both directions", async () => {
    if (!booted) return;
    // A cursor is opaque but not trusted: its id reaches a uuid column and a
    // date sort's value a timestamptz cast, so a crafted one used to be a 500
    // from PostgreSQL rather than the 400 this contract declares. The
    // fingerprint is public — it is derived from the sort and the filters — so
    // a caller can produce a cursor that passes every check except the
    // value's.
    //
    // `2026-02-29 00:00:00+00` is the case a shape test cannot catch: it is
    // formatted exactly as this column renders, and PostgreSQL still answers
    // `date/time field value out of range`, because 2026 is not a leap year.
    const { createHash } = await import("node:crypto");
    const forge = (payload: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const fingerprint = (parts: readonly (string | undefined)[]) =>
      createHash("sha256").update(JSON.stringify(parts.map((part) => part ?? null)))
        .digest("base64url").slice(0, 16);

    // A parent to list credentials under, so the credential listing is refused
    // on its cursor rather than on a missing integration.
    const parent = await operation("create", {
      displayName: "Cursor subject", roles: [READ_ROLE], expiresInDays: 30,
    });
    expect(parent.status).toBe(200);
    const integrationId = parent.body.integration.integrationId as string;

    const listings = [
      {
        path: "list",
        query: fingerprint(["integrations", undefined, undefined]),
        input: {} as Record<string, unknown>,
        dateSort: "updatedAt",
        textSort: "displayName",
      },
      {
        path: "list-credentials",
        query: fingerprint(["credentials", integrationId, undefined, undefined]),
        input: { integrationId },
        dateSort: "expiresAt",
        textSort: "displayName",
      },
    ];
    const impossible = [
      ["2026-99-99 99:99:99+99", "every field out of range, perfectly shaped"],
      ["2026-02-29 00:00:00+00", "February 29th of a common year"],
      ["2026-01-01 00:00:00+16", "a displacement past PostgreSQL's limit"],
      ["2026-01-02 00:00:00+00'); select 1 --", "a value with a statement appended"],
      ["yesterday", "a word PostgreSQL would otherwise parse"],
    ];

    for (const listing of listings) {
      for (const direction of ["asc", "desc"] as const) {
        for (const [value, why] of impossible) {
          const response = await operation(listing.path, {
            ...listing.input,
            sortField: listing.dateSort, sortDirection: direction,
            after: forge({
              f: listing.dateSort, d: direction, q: listing.query, v: value, i: randomUUID(),
            }),
          });
          expect({
            where: `${listing.path} ${direction} ${why}`,
            status: response.status, code: response.body.error?.code,
          }).toEqual({
            where: `${listing.path} ${direction} ${why}`, status: 400, code: "VALIDATION",
          });
        }
        // The other half of the keyset, on the text sort, where the value is
        // not a timestamp but the id still reaches a uuid column.
        const badId = await operation(listing.path, {
          ...listing.input,
          sortField: listing.textSort, sortDirection: direction,
          after: forge({
            f: listing.textSort, d: direction, q: listing.query,
            v: "cursor subject", i: "not-a-uuid",
          }),
        });
        expect({
          where: `${listing.path} ${direction} id`,
          status: badId.status, code: badId.body.error?.code,
        }).toEqual({ where: `${listing.path} ${direction} id`, status: 400, code: "VALIDATION" });
      }
    }
  }, TEST_TIMEOUT);

  test("pages both listings in both directions with the cursors it issued", async () => {
    if (!booted) return;
    // The check on a cursor's value only earns its place if a real one still
    // passes it. These walks resume on the sorts whose value the DATABASE
    // renders and casts back — a timestamptz for the date sorts, including the
    // nullable `expiresAt` and `lastUsedAt` whose NULL block is resumed on the
    // id alone — one row at a time, over the dispatcher, until the listing
    // says there is no more.
    const names = ["Alpha partner", "Beta partner", "Gamma partner"];
    const integrationIds: string[] = [];
    for (const name of names) {
      const created = await operation("create", {
        displayName: name, roles: [READ_ROLE], expiresInDays: 30,
      });
      expect(created.status).toBe(200);
      integrationIds.push(created.body.integration.integrationId as string);
    }
    // Two more credentials under the first integration, so its own listing has
    // something to page. None of them has ever been used, which is what puts
    // the whole `lastUsedAt` walk below inside the NULL block — the branch of
    // the resume predicate that has no value to compare and carries only the
    // id.
    const parent = integrationIds[0]!;
    for (const displayName of ["Rotation", "Second rotation"]) {
      expect((await operation("issue-credential", {
        integrationId: parent, displayName, expiresInDays: 30,
      })).status).toBe(200);
    }

    /** Walk one listing to its end, one row per page, and return what it gave. */
    const walk = async (
      path: string,
      input: Record<string, unknown>,
      collection: string,
      sortField: string,
      sortDirection: "asc" | "desc",
    ): Promise<string[]> => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const response = await operation(path, {
          ...input, sortField, sortDirection, first: 1,
          ...(after === undefined ? {} : { after }),
        });
        expect({ page, sortField, sortDirection, status: response.status })
          .toEqual({ page, sortField, sortDirection, status: 200 });
        for (const row of response.body[collection] as { displayName: string }[]) {
          seen.push(row.displayName);
        }
        after = response.body.nextCursor ?? undefined;
        if (!after) break;
      }
      expect(after).toBeUndefined();
      return seen;
    };

    for (const sortField of ["createdAt", "updatedAt", "displayName"]) {
      const ascending = await walk("list", {}, "integrations", sortField, "asc");
      const descending = await walk("list", {}, "integrations", sortField, "desc");
      // Every row, once, whichever way the walk went.
      expect(new Set(ascending)).toEqual(new Set(descending));
      expect(ascending.length).toBe(new Set(ascending).size);
      for (const name of names) expect(ascending).toContain(name);
    }

    for (const sortField of ["createdAt", "expiresAt", "lastUsedAt", "displayName"]) {
      const ascending = await walk(
        "list-credentials", { integrationId: parent }, "credentials", sortField, "asc",
      );
      const descending = await walk(
        "list-credentials", { integrationId: parent }, "credentials", sortField, "desc",
      );
      expect(new Set(ascending)).toEqual(new Set(descending));
      expect(ascending.length).toBe(new Set(ascending).size);
      expect(ascending).toContain("Rotation");
      expect(ascending).toContain("Second rotation");
    }
  }, TEST_TIMEOUT);

  test("pages a name at the contract's limit, in code points rather than units", async () => {
    if (!booted) return;
    // 200 emoji: 200 characters to the input schema that accepts them, 400
    // UTF-16 units to JavaScript, 800 bytes to UTF-8 — and, on a cursor that
    // carried the row's sort value, some 1.1 kB of base64 that the ceiling
    // refused before parsing. The administrator could create the integration
    // and then could not page past it. Driven here over the real dispatcher,
    // so the schema's own `maxLength` is what admits the name and the authored
    // `after` bound is what has to admit the cursor.
    const names = [
      "\u{1f389}".repeat(MAX_DISPLAY_NAME_LENGTH),
      "\u56de".repeat(MAX_DISPLAY_NAME_LENGTH),
      `\u0130stanbul ${"\u015e".repeat(MAX_DISPLAY_NAME_LENGTH - 9)}`,
    ];
    const created: string[] = [];
    for (const displayName of names) {
      const response = await operation("create", {
        displayName, roles: [READ_ROLE], expiresInDays: 30,
      });
      expect({ name: displayName.slice(0, 8), status: response.status })
        .toEqual({ name: displayName.slice(0, 8), status: 200 });
      created.push(response.body.integration.integrationId as string);
      // A credential under the first of them, named the same way, so the
      // credential listing's name sort carries the same value.
      expect((await operation("issue-credential", {
        integrationId: created[0], displayName, expiresInDays: 30,
      })).status).toBe(200);
    }

    /** Walk one listing to its end over HTTP, one row per page. */
    const walk = async (
      path: string,
      input: Record<string, unknown>,
      collection: string,
      sortField: string,
      sortDirection: "asc" | "desc",
    ): Promise<string[]> => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 200; page += 1) {
        const response = await operation(path, {
          ...input, sortField, sortDirection, first: 1,
          ...(after === undefined ? {} : { after }),
        });
        expect({ page, sortField, sortDirection, status: response.status })
          .toEqual({ page, sortField, sortDirection, status: 200 });
        for (const row of response.body[collection] as { id?: string; integrationId?: string }[]) {
          seen.push((row.id ?? row.integrationId)!);
        }
        after = response.body.nextCursor ?? undefined;
        if (!after) break;
      }
      expect(after).toBeUndefined();
      return seen;
    };

    for (const sortField of ["displayName", "createdAt"]) {
      for (const direction of ["asc", "desc"] as const) {
        const seen = await walk("list", {}, "integrations", sortField, direction);
        // Every long-named integration is reached, each exactly once: the walk
        // went past them rather than stopping at the first cursor.
        expect(seen.length).toBe(new Set(seen).size);
        for (const id of created) {
          expect({ sortField, direction, reached: seen.includes(id) })
            .toEqual({ sortField, direction, reached: true });
        }
        const credentials = await walk(
          "list-credentials", { integrationId: created[0] }, "credentials", sortField, direction,
        );
        expect(credentials.length).toBe(new Set(credentials).size);
        expect(credentials.length).toBeGreaterThanOrEqual(names.length);
      }
    }
  }, TEST_TIMEOUT);

  test("refuses a name past the Operation's limit as a declared 400", async () => {
    if (!booted) return;
    // The bound is the OPERATION's. The dispatcher applies it from the
    // authored input schema, which is what every caller of these Operations
    // meets.
    const parent = await operation("create", {
      displayName: "Length subject", roles: [READ_ROLE], expiresInDays: 30,
    });
    expect(parent.status).toBe(200);
    const integrationId = parent.body.integration.integrationId as string;
    const tooLong = "\u{1f389}".repeat(MAX_DISPLAY_NAME_LENGTH + 1);
    for (const [path, input] of [
      ["create", { displayName: tooLong, roles: [READ_ROLE], expiresInDays: 30 }],
      ["issue-credential", { integrationId, displayName: tooLong, expiresInDays: 30 }],
    ] as const) {
      const response = await operation(path, input);
      // A declared client error and not a 500 or a stored row.
      expect({ path, status: response.status, code: response.body.error?.code })
        .toEqual({ path, status: 400, code: "BAD_USER_INPUT" });
    }
  }, TEST_TIMEOUT);

  test("keeps the input the older surfaces have always accepted", async () => {
    if (!booted) return;
    // These two functions are not reached only through the Operations above:
    // `auth/api-key/rest-routes.ts` and `graphql-schema.ts` have called them
    // since before the Operations existed, and they bound the name nowhere —
    // a `String!` and a `typeof body.displayName === "string"`. A service-level
    // bound added for the sake of paging would narrow both of those published
    // contracts without either of them changing, so this is what they sent and
    // what they must still be answered with. Called directly, as those mounts
    // call them, rather than through the dispatcher that declares more.
    const deps = booted.deps;
    const far = "\u{1f389}".repeat(MAX_DISPLAY_NAME_LENGTH * 5);
    const created = await createIntegration(deps, provisioningSession(), {
      displayName: far, roles: [READ_ROLE], expiresInDays: 30,
    });
    expect(created.integration.displayName).toBe(far);
    expect(created.token).toMatch(/^osf_/);

    // And a credential's name, which the REST mount substitutes when absent
    // and passes through when empty — so an empty one is stored, not refused.
    const issued = await issueKey(deps, provisioningSession(), {
      integrationId: created.integrationId, displayName: "", expiresInDays: 30,
    });
    expect(issued.token).toMatch(/^osf_/);
    const credentials = await listKeys(deps, provisioningSession(), {
      integrationId: created.integrationId,
    });
    expect(credentials.map((key) => key.displayName).sort())
      .toEqual(["", far].sort());

    // An integration still needs a name, because that one names the realm
    // client and the row every later call addresses — which is what the older
    // surfaces refused too.
    await expect(createIntegration(deps, provisioningSession(), {
      displayName: "   ", roles: [READ_ROLE], expiresInDays: 30,
    })).rejects.toThrow(/needs a display name/);

    // The long-named integration pages, over the dispatcher, past the row a
    // value-carrying cursor could not have taken back.
    let after: string | undefined;
    const seen: string[] = [];
    for (let page = 0; page < 400; page += 1) {
      const response = await operation("list", {
        sortField: "displayName", sortDirection: "asc", first: 1,
        ...(after === undefined ? {} : { after }),
      });
      expect({ page, status: response.status, code: response.body.error?.code })
        .toEqual({ page, status: 200, code: undefined });
      for (const row of response.body.integrations as { integrationId: string }[]) {
        seen.push(row.integrationId);
      }
      after = response.body.nextCursor ?? undefined;
      if (!after) break;
    }
    expect(after).toBeUndefined();
    expect(seen).toContain(created.integrationId);
    expect(seen.length).toBe(new Set(seen).size);
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

/**
 * The same catalog, reached by each principal class the server can establish.
 *
 * The suite above is the person who HAS a Relation, which is the ordinary
 * administrator and the only shape a session rebuilt from the service's own
 * fields could ever reproduce. These are the shapes it could not:
 *
 *   - a signed person with NO Relation. There is no identity link to read, so
 *     `person` comes from the verdict inside the bundle's HMAC and from
 *     nowhere else. A session re-derived from the active database session
 *     would be classified `unknown` and refused by the nested-session fence,
 *     which is what `db/__tests__/principal-class-session.test.ts` pins at the
 *     session layer and what this proves through the whole dispatcher;
 *   - an unclassified v2 producer, which still does ordinary work and reaches
 *     no credential management at all;
 *   - a person on another tenant, and a person without the management role.
 *
 * The forged case is here rather than only in `carrier-admission.test.ts`
 * because the question is about this surface: appending the class header to a
 * bundle this deployment really signed must change nothing.
 */
describe("the catalog over the real dispatcher, by principal class", () => {
  /** An ordinary generic read: the entity CRUD every existing caller uses. */
  async function ordinaryRead(headers: Record<string, string>) {
    const response = await booted!.app.inject({
      method: "GET",
      url: "/api/rest/v1/relations",
      headers,
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, any> };
  }

  test("a signed person with no Relation manages the catalog end to end", async () => {
    if (!booted) return;
    const headers = signedHop({ userId: UNLINKED_MANAGER, principalKind: "person" });

    const created = await operation(
      "create",
      { displayName: "Unlinked admin portal", roles: [READ_ROLE], expiresInDays: 30 },
      headers,
    );
    expect({ status: created.status, code: created.body.error?.code })
      .toEqual({ status: 200, code: undefined });
    const integrationId = created.body.integration.integrationId as string;
    expect(created.body.credential?.secret).toBeTypeOf("string");

    // Written by this person, under this tenant, with no acting Relation to
    // borrow — the row proves the session reached the database as itself.
    const stored = await sql<{ created_by: string; status: string }>`
      select created_by::text as created_by, status
        from platform.api_key_integrations
       where id = ${integrationId}::uuid and tenant_id = ${TENANT}::uuid
    `.execute(booted.adminDb);
    expect(stored.rows[0]).toEqual({ created_by: UNLINKED_MANAGER, status: "active" });

    // And every other writing Operation, which is where the second session
    // would have been opened inside the dispatcher's transaction.
    const issued = await operation(
      "issue-credential",
      { integrationId, displayName: "Rotation", expiresInDays: 30 },
      headers,
    );
    expect(issued.status).toBe(200);
    const revoked = await operation(
      "revoke-credential",
      { id: issued.body.credential.id },
      headers,
    );
    expect(revoked).toMatchObject({ status: 200, body: { status: "revoked" } });
    const disabled = await operation("disable", { integrationId }, headers);
    expect(disabled.status).toBe(200);

    const listed = await operation("list", { first: 50 }, headers);
    expect(listed.status).toBe(200);
    expect(listed.body.integrations.map((entry: { integrationId: string }) => entry.integrationId))
      .toContain(integrationId);
  }, TEST_TIMEOUT);

  test("an unclassified v2 producer works as before and manages no credential", async () => {
    if (!booted) return;
    const v2 = unclassifiedV2Hop();

    // The ordinary flow is untouched: the bundle verifies, its tenant and its
    // roles arrive, and the generic entity read answers for them.
    const read = await ordinaryRead(v2);
    expect(read.status).toBe(200);

    // The same bundle reaches no credential management, read or write. 403 and
    // not 401: it IS an authenticated session: the carrier rule refuses it.
    for (const [path, input] of [
      ["list", { first: 10 }],
      ["create", {
        confirmed: true, displayName: "v2 should not", roles: [READ_ROLE], expiresInDays: 30,
      }],
    ] as const) {
      const refused = await operation(path, input as Record<string, unknown>, v2);
      expect({ path, status: refused.status, code: refused.body.error?.code })
        .toEqual({ path, status: 403, code: "FORBIDDEN" });
      expect(refused.body.error.message).toMatch(/Only a verified person may manage API keys/);
    }
    const none = await sql<{ count: string }>`
      select count(*)::text as count from platform.api_key_integrations
       where tenant_id = ${TENANT}::uuid and display_name = 'v2 should not'
    `.execute(booted.adminDb);
    expect(none.rows[0]!.count).toBe("0");
  }, TEST_TIMEOUT);

  test("a class appended to a genuinely signed v2 bundle changes nothing", async () => {
    if (!booted) return;
    const forged = { ...unclassifiedV2Hop(), [TRUSTED_CONTEXT_HEADERS.principalKind]: "person" };
    const refused = await operation("list", { first: 10 }, forged);
    // The v2 signature does not cover the class, and the v3 payload the header
    // now implies is not what was signed — so the bundle verifies as v2 and
    // stays unclassified rather than becoming a person.
    expect({ status: refused.status, code: refused.body.error?.code })
      .toEqual({ status: 403, code: "FORBIDDEN" });
    expect(refused.body.error.message).toMatch(/Only a verified person may manage API keys/);
  }, TEST_TIMEOUT);

  test("a verified person of another tenant sees none of this tenant's catalog", async () => {
    if (!booted) return;
    const neighbour = signedHop({
      userId: randomUUID(),
      tenantId: OTHER_TENANT,
      principalKind: "person",
    });
    const listed = await operation("list", { first: 50 }, neighbour);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ integrations: [], totalCount: 0 });
  }, TEST_TIMEOUT);

  test("a verified person without the management role is refused", async () => {
    if (!booted) return;
    const reader = signedHop({
      userId: MANAGER,
      roles: [READ_ROLE],
      principalKind: "person",
    });
    const refused = await operation("list", { first: 10 }, reader);
    // The carrier was fine, so the role is what refuses — and it refuses at
    // the Operation's own declared `roles: [Platform.ApiKeys.Manage]`, before
    // the handler and therefore before the ceiling says the same thing about
    // the same role (ceiling.test.ts covers that second answer directly). The
    // rung this test holds is that dropping the role drops the surface.
    expect({ status: refused.status, code: refused.body.error?.code })
      .toEqual({ status: 403, code: "FORBIDDEN" });
    expect(refused.body.error.message).toMatch(/required operation role/);

    // Nothing was created, and the manage-role holder still reaches it.
    const stillReaches = await operation("list", { first: 10 });
    expect(stillReaches.status).toBe(200);
  }, TEST_TIMEOUT);
});
