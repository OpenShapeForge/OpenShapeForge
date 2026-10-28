// SPDX-License-Identifier: BUSL-1.1
/**
 * `no-store` as a BOOTED deployment actually sends it.
 *
 * `credential-response.test.ts` proves the REST mounts on a Fastify instance
 * that registers the routes under test, and proves the GraphQL marker against
 * a reply object it builds itself. That last part is the gap this file
 * closes: the marker only matters if the reply Yoga merges into the resolver
 * context is the real one, on the real mount, in the real plugin order. A
 * stub reply cannot show that, and a schema built in isolation cannot show
 * that the two minting mutations are even reachable.
 *
 * So the whole thing runs: `createApiApp` with Yoga, the compiled schema and
 * the shipped plugin stack, against a scratch PostgreSQL this file creates
 * and drops, with the realm half answered by a stub Keycloak Admin API over
 * real HTTP. The only doubles are the realm and the clock; the response
 * headers asserted here are the ones that left the socket.
 *
 * Skips wholesale when no PostgreSQL is reachable, so it never fails for the
 * wrong reason; point `SCRATCH_ADMIN_DATABASE_URL` at an isolated server.
 */
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import type { DB } from "../../generated/db/types.js";
import { API_KEY_MANAGE_ROLE } from "./ceiling.js";
import { stubRealm, type StubRealm } from "./__tests__/fixtures.js";
import { API_KEY_MOUNT } from "./rest-routes.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 180_000;

const TENANT = randomUUID();
const MANAGER = randomUUID();
const READ_ROLE = "Relations.All.Read";
const ISSUER = "https://identity.test/realms/openshapeforge";

/** The headers a response carrying a one-time credential must leave with. */
const EXPECTED_NO_STORE = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache" };

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

type Booted = {
  app: Awaited<ReturnType<typeof import("../../roles/api.js").createApiApp>>;
  adminDb: Kysely<DB>;
  logged: string[];
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

function graphql(query: string, variables?: Record<string, unknown>) {
  return booted!.app.inject({
    method: "POST",
    url: "/api/graphql",
    headers: managerHeaders(),
    payload: JSON.stringify({ query, variables }),
  });
}

beforeAll(async () => {
  if (!(await serverReachable())) {
    console.log(
      `[api-key no-store] SKIPPED — no PostgreSQL at ${new URL(ADMIN_URL).host}. ` +
        "Set SCRATCH_ADMIN_DATABASE_URL to an isolated server to run this suite.",
    );
    return;
  }
  realm = stubRealm({ roles: [READ_ROLE] });
  databaseName = `api_key_no_store_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${databaseName}"`);
  const admin = createDatabaseRuntime({ databaseUrl: databaseUrl(databaseName), maxConnections: 4 });
  await admin.db.connection().execute((trx) => runMigrationChain(trx));
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${TENANT}, 'no-store', 'No Store', 'active', 'openshapeforge')
  `.execute(admin.db);

  // Set BEFORE the app is built: the GraphQL schema resolves the provisioning
  // configuration once, at build time, and the session layer needs an issuer
  // to name the identity behind a trusted-context bundle.
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??= "no-store-suite-context-secret";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
  process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS = `test:${randomBytes(32).toString("base64")}`;
  process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = realm.baseUrl;
  process.env.OPENSHAPEFORGE_KEYCLOAK_REALM = realm.realm;
  process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID = "provisioner";
  process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET = "provisioner-secret";
  // This suite drives a handful of requests; the shipped per-caller budget is
  // not what it measures.
  process.env.API_RATE_LIMIT_MAX ??= "100000";
  process.env.API_RATE_LIMIT_MAX_TRUSTED ??= "100000";

  const { createApiApp } = await import("../../roles/api.js");
  const { __resetSessionResolverForTests } = await import("../identity.js");
  __resetSessionResolverForTests();
  // Every log line is captured: a secret in a request log outlives the
  // response that was so carefully marked uncacheable.
  const logged: string[] = [];
  const app = createApiApp({
    cors: false,
    databaseUrl: databaseUrl(databaseName, true),
    logStream: { write: (line: string) => void logged.push(line) },
  });
  await app.ready();
  booted = {
    app,
    adminDb: admin.db,
    logged,
    close: async () => {
      await app.close();
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

describe("a booted deployment hands credentials over uncacheable", () => {
  test("the GraphQL mint marks the reply Yoga really merged in", async () => {
    if (!booted) return;
    const response = await graphql(
      `mutation Mint($input: CreateApiKeyIntegrationInput!) {
         createApiKeyIntegration(input: $input) { integrationId keyId token expiresAt }
       }`,
      { input: { displayName: "Partner portal", roles: [READ_ROLE], expiresInDays: 30 } },
    );
    const body = JSON.parse(response.body) as {
      data?: { createApiKeyIntegration?: { token?: string; integrationId?: string } };
      errors?: { message: string }[];
    };
    expect({ status: response.statusCode, errors: body.errors }).toMatchObject({ status: 200 });
    const token = body.data?.createApiKeyIntegration?.token;
    expect(typeof token).toBe("string");
    expect(response.headers["cache-control"]).toBe(EXPECTED_NO_STORE["cache-control"]);
    expect(response.headers.pragma).toBe(EXPECTED_NO_STORE.pragma);

    // The rotation mutation is the second minting path and carries the same
    // marker; proving one does not prove the other.
    const rotated = await graphql(
      `mutation Rotate($input: IssueApiKeyInput!) {
         issueApiKey(input: $input) { keyId token }
       }`,
      {
        input: {
          integrationId: body.data!.createApiKeyIntegration!.integrationId,
          displayName: "Rotation",
          expiresInDays: 30,
        },
      },
    );
    const rotatedBody = JSON.parse(rotated.body) as {
      data?: { issueApiKey?: { token?: string } };
      errors?: { message: string }[];
    };
    expect({ status: rotated.statusCode, errors: rotatedBody.errors }).toMatchObject({ status: 200 });
    expect(rotated.headers["cache-control"]).toBe(EXPECTED_NO_STORE["cache-control"]);
    expect(rotated.headers.pragma).toBe(EXPECTED_NO_STORE.pragma);

    // Neither secret reached the structured log or the realm.
    const transcript = booted.logged.join("\n");
    for (const secret of [token!, rotatedBody.data!.issueApiKey!.token!]) {
      expect(transcript).not.toContain(secret);
      expect(JSON.stringify(realm.requests)).not.toContain(secret);
    }
  }, TEST_TIMEOUT);

  test("a GraphQL metadata read over the same mount is left cacheable", async () => {
    if (!booted) return;
    // The marker is attached by the two minting resolvers, not by the mount,
    // so a query on the identical endpoint must come back unmarked.
    const response = await graphql(`query Keys { apiKeys { id displayName expiresAt } }`);
    const body = JSON.parse(response.body) as {
      data?: { apiKeys?: unknown[] };
      errors?: { message: string }[];
    };
    expect({ status: response.statusCode, errors: body.errors }).toMatchObject({ status: 200 });
    expect(body.data?.apiKeys?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("osf_");
    expect(response.headers["cache-control"]).toBeUndefined();
  }, TEST_TIMEOUT);

  test("the REST mount on the same booted app marks its 201 too", async () => {
    if (!booted) return;
    const created = await booted.app.inject({
      method: "POST",
      url: API_KEY_MOUNT,
      headers: managerHeaders(),
      payload: JSON.stringify({
        displayName: "Reporting job", roles: [READ_ROLE], expiresInDays: 30,
      }),
    });
    expect({ status: created.statusCode, body: created.body }).toMatchObject({ status: 201 });
    expect(created.headers["cache-control"]).toBe(EXPECTED_NO_STORE["cache-control"]);
    expect(created.headers.pragma).toBe(EXPECTED_NO_STORE.pragma);
    expect(booted.logged.join("\n")).not.toContain(created.json().token as string);

    const listed = await booted.app.inject({
      method: "GET", url: API_KEY_MOUNT, headers: managerHeaders(),
    });
    expect({ status: listed.statusCode, body: listed.body }).toMatchObject({ status: 200 });
    expect(listed.headers["cache-control"]).toBeUndefined();
  }, TEST_TIMEOUT);

  test("an in-mesh hop with no principal class reaches neither surface", async () => {
    if (!booted) return;
    // The carrier rule, through the booted stack rather than the resolver
    // alone: the same bundle minus the signed class is refused on both.
    const headers = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(headers, {
      tenantId: TENANT, userId: MANAGER, roles: [API_KEY_MANAGE_ROLE, READ_ROLE],
    }, { secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET! });
    const unclassified = Object.fromEntries(headers.entries());

    const listed = await booted.app.inject({
      method: "GET", url: API_KEY_MOUNT, headers: unclassified,
    });
    expect(listed.statusCode).toBe(403);

    const queried = await booted.app.inject({
      method: "POST",
      url: "/api/graphql",
      headers: unclassified,
      payload: JSON.stringify({ query: `query Keys { apiKeys { id } }` }),
    });
    expect(JSON.parse(queried.body).errors?.[0]?.message)
      .toMatch(/Only a verified person may manage API keys/);
  }, TEST_TIMEOUT);
});
