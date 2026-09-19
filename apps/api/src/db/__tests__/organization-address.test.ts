// SPDX-License-Identifier: BUSL-1.1
/**
 * A short address names an organization for REST and GraphQL too:
 * `/<alias>/api/...` and `/<alias>/graphql` refuse a credential of another
 * tenant, the way the per-organization MCP resource does. End to end through
 * createApiApp against a migrated scratch database, so the routing hook that
 * carries the alias, the session resolver's check and the registry read are
 * all the real ones.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { __resetSessionResolverForTests } from "../../auth/identity.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { createApiApp } from "../../roles/api.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const SECRET = "organization-address-test-secret";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const TEST_TIMEOUT = 180_000;

const name = `organization_address_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const server = new SQL(ADMIN_URL, { max: 1 });
let app: ReturnType<typeof createApiApp> | undefined;
let admin: ReturnType<typeof createDatabaseRuntime> | undefined;
const savedSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
const savedMode = process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;

function databaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

beforeAll(async () => {
  await server.unsafe(`create database "${name}"`);
  admin = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 4 });
  await (admin.db as Kysely<DB>).connection().execute((trx) => runMigrationChain(trx));
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${TENANT_A}, 'alpha', 'Alpha', 'active', 'openshapeforge'),
           (${TENANT_B}, 'beta', 'Beta', 'active', 'openshapeforge')
  `.execute(admin.db);
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = SECRET;
  delete process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
  __resetSessionResolverForTests();
  app = createApiApp({ cors: false, databaseUrl: databaseUrl(), modules: await loadRuntimeModules() });
  await app.ready();
}, TEST_TIMEOUT);

afterAll(async () => {
  await app?.close();
  await admin?.close();
  await server.unsafe(`drop database if exists "${name}" with (force)`);
  await server.close();
  if (savedSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = savedSecret;
  if (savedMode === undefined) delete process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
  else process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = savedMode;
  __resetSessionResolverForTests();
});

function credentialFor(tenantId: string): Record<string, string> {
  const headers = new Headers();
  applyTrustedContextHeaders(
    headers,
    { tenantId, userId: USER, roles: ["Relations.All.Read", "Relations.All.ReadWrite"] },
    { secret: SECRET },
  );
  return Object.fromEntries(headers.entries());
}

describe("short addresses on REST and GraphQL", () => {
  test(
    "a credential for tenant A is refused at /beta/api/... and admitted at /alpha/api/...",
    async () => {
      const refused = await app!.inject({
        method: "GET",
        url: "/beta/api/rest/v1/relations",
        headers: credentialFor(TENANT_A),
      });
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body).error.code).toBe("ORGANIZATION_RESOURCE_FORBIDDEN");

      const admitted = await app!.inject({
        method: "GET",
        url: "/alpha/api/rest/v1/relations",
        headers: credentialFor(TENANT_A),
      });
      expect(admitted.statusCode).toBe(200);

      // The long spelling names no organization and keeps working.
      const plain = await app!.inject({
        method: "GET",
        url: "/api/rest/v1/relations",
        headers: credentialFor(TENANT_A),
      });
      expect(plain.statusCode).toBe(200);

      // A client cannot pick the organization itself: the server sets the
      // header from the URL and deletes what the client sent.
      const spoofed = await app!.inject({
        method: "GET",
        url: "/api/rest/v1/relations",
        headers: { ...credentialFor(TENANT_A), "x-openshapeforge-organization-address": "beta" },
      });
      expect(spoofed.statusCode).toBe(200);
    },
    TEST_TIMEOUT,
  );

  test(
    "the same rule holds for /<alias>/graphql",
    async () => {
      const query = JSON.stringify({ query: "{ relations(first: 1) { data { totalCount } error { code } } }" });
      const refused = await app!.inject({
        method: "POST",
        url: "/beta/graphql",
        headers: { ...credentialFor(TENANT_A), "content-type": "application/json" },
        payload: query,
      });
      expect(refused.statusCode).not.toBe(200);
      expect(refused.body).toContain("ORGANIZATION_RESOURCE_FORBIDDEN");

      const admitted = await app!.inject({
        method: "POST",
        url: "/alpha/graphql",
        headers: { ...credentialFor(TENANT_A), "content-type": "application/json" },
        payload: query,
      });
      expect(admitted.statusCode).toBe(200);
      expect(admitted.body).not.toContain("ORGANIZATION_RESOURCE_FORBIDDEN");
    },
    TEST_TIMEOUT,
  );
});
