// SPDX-License-Identifier: BUSL-1.1
/** Real DB + injected HTTPS protocol responses; not a live Keycloak/TLS claim. */
import { beforeAll, afterAll, test, expect } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import {
  readManagedMaintenanceConfiguration,
  runManagedTenantMaintenance,
} from "../../control/maintenance.js";
const admin = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const name = `managed_${randomUUID().replaceAll("-", "")}`;
const url = new URL(admin);
url.pathname = `/${name}`;
const config = readManagedMaintenanceConfiguration({
  OPENSHAPEFORGE_PUBLIC_ORIGIN: "https://app.example.test",
  OPENSHAPEFORGE_MCP_CLIENTS: "example-web",
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "https://identity.example.test",
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM: "example",
  OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID: "openshapeforge-auth-api",
  KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API: "fixture-secret",
  OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE: name,
  OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE_ROLE: "openshapeforge",
});
const organizationId = randomUUID();
let returnedId = organizationId;
let requests: string[] = [];
let wrongIdentity = false;
let runtime: DatabaseRuntime;
let server: SQL;
const oldMode = process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT,
  oldOrigin = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN,
  oldRealm = process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM;
const protocol = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  requests.push(`${init?.method ?? "GET"} ${path}`);
  let body: unknown;
  if (path.endsWith("/protocol/openid-connect/token")) {
    const claims = {
      azp: wrongIdentity ? "foreign-client" : config.keycloak.clientId,
      sub: "actual-service-principal",
      iss: `${config.keycloak.baseUrl}/realms/example`,
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    body = {
      access_token: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
      expires_in: 300,
    };
  } else if (path.endsWith("/openshapeforge/organizations"))
    body = { id: returnedId, alias: "example" };
  else if (path === `/admin/realms/example/organizations/${organizationId}`)
    body = {
      id: organizationId,
      alias: "example",
      name: "Example",
      enabled: true,
    };
  else throw new Error(`Unexpected protocol request ${path}`);
  return Response.json(body);
}) as typeof fetch;
const request = {
  action: "provision" as const,
  tenant: "example",
  name: "Example",
  confirmed: true,
};
beforeAll(async () => {
  server = new SQL(admin);
  await server.unsafe(`create database "${name}"`);
  runtime = createDatabaseRuntime({ databaseUrl: url.toString() });
  await runtime.db.connection().execute((db) => runMigrationChain(db));
  // This test is the actual single-host scope mode, not a bypass of provider scope writes.
  process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM = "example";
  process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = config.mcpResource.origins[0];
}, 90_000);
afterAll(async () => {
  for (const [key, value] of [
    ["OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM", oldRealm],
    ["OPENSHAPEFORGE_ORGANIZATION_CONTEXT", oldMode],
    ["OPENSHAPEFORGE_PUBLIC_ORIGIN", oldOrigin],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  await runtime?.close();
  await server.unsafe(`drop database "${name}" with (force)`);
  await server.close();
});
test("missing confirmation and wrong actual database/role refuse before provider access", async () => {
  requests = [];
  await expect(
    runManagedTenantMaintenance(
      { ...request, confirmed: false },
      config,
      runtime.db,
      protocol,
    ),
  ).rejects.toThrow("confirmation");
  await expect(
    runManagedTenantMaintenance(
      request,
      { ...config, database: "other" },
      runtime.db,
      protocol,
    ),
  ).rejects.toThrow("boundary");
  await expect(
    runManagedTenantMaintenance(
      request,
      { ...config, role: "other" },
      runtime.db,
      protocol,
    ),
  ).rejects.toThrow("boundary");
  expect(requests).toEqual([]);
});
test("wrong service principal refuses before audited tenant reads or writes", async () => {
  wrongIdentity = true;
  try {
    await expect(
      runManagedTenantMaintenance(request, config, runtime.db, protocol),
    ).rejects.toThrow("identity mismatch");
  } finally {
    wrongIdentity = false;
  }
  expect(
    (await sql`select id from platform.tenants`.execute(runtime.db)).rows,
  ).toEqual([]);
  expect(
    (await sql`select id from platform.system_bypass_audit`.execute(runtime.db))
      .rows,
  ).toEqual([]);
});
test("fresh tenant and existing binding replay use actual service provenance and one SPI create", async () => {
  const first = await runManagedTenantMaintenance(
    request,
    config,
    runtime.db,
    protocol,
  );
  expect(first).toHaveProperty("tenant.keycloakOrganizationId", organizationId);
  requests = [];
  const replay = await runManagedTenantMaintenance(
    request,
    config,
    runtime.db,
    protocol,
  );
  expect(replay).toHaveProperty(
    "tenant.keycloakOrganizationId",
    organizationId,
  );
  expect(
    requests.filter((value) => value.endsWith("/openshapeforge/organizations")),
  ).toHaveLength(1);
  const rows = await sql<{
    actor_subject: string;
  }>`select actor_subject from platform.system_bypass_audit`.execute(
    runtime.db,
  );
  expect(rows.rows.length).toBeGreaterThan(0);
  expect(
    rows.rows.every(
      (row) =>
        row.actor_subject ===
        "https://identity.example.test/realms/example#actual-service-principal",
    ),
  ).toBe(true);
});
test("provider replacement refuses before tenant, ERP or starter-group mutation", async () => {
  const before =
    await sql`select row_to_json(t) as row from platform.tenants t`.execute(
      runtime.db,
    );
  const erpBefore =
    await sql`select row_to_json(t) as row from erp.tenants t`.execute(
      runtime.db,
    );
  const groupsBefore =
    await sql`select row_to_json(t) as row from erp.relation_groups t order by id`.execute(
      runtime.db,
    );
  const rolesBefore =
    await sql`select row_to_json(t) as row from platform.relation_group_roles t order by relation_group_id, role`.execute(
      runtime.db,
    );
  returnedId = randomUUID();
  try {
    await expect(
      runManagedTenantMaintenance(
        { ...request, name: "Would mutate" },
        config,
        runtime.db,
        protocol,
      ),
    ).rejects.toThrow("must not be replaced");
  } finally {
    returnedId = organizationId;
  }
  expect(
    (
      await sql`select row_to_json(t) as row from platform.tenants t`.execute(
        runtime.db,
      )
    ).rows,
  ).toEqual(before.rows);
  expect(
    (
      await sql`select row_to_json(t) as row from erp.tenants t`.execute(
        runtime.db,
      )
    ).rows,
  ).toEqual(erpBefore.rows);
  expect(
    (
      await sql`select row_to_json(t) as row from erp.relation_groups t order by id`.execute(
        runtime.db,
      )
    ).rows,
  ).toEqual(groupsBefore.rows);
  expect(
    (
      await sql`select row_to_json(t) as row from platform.relation_group_roles t order by relation_group_id, role`.execute(
        runtime.db,
      )
    ).rows,
  ).toEqual(rolesBefore.rows);
});
test("closed get returns existing tenant and absent null", async () => {
  expect(
    await runManagedTenantMaintenance(
      { ...request, action: "get" },
      config,
      runtime.db,
      protocol,
    ),
  ).toHaveProperty("tenant.keycloakOrganizationId", organizationId);
  expect(
    await runManagedTenantMaintenance(
      { ...request, action: "get", tenant: "absent" },
      config,
      runtime.db,
      protocol,
    ),
  ).toBeNull();
});

test("configuration refuses insecure TLS routes and missing resource clients", () => {
  const env = {
    OPENSHAPEFORGE_PUBLIC_ORIGIN: "https://app.example.test",
    OPENSHAPEFORGE_MCP_CLIENTS: "example-web",
    OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "http://identity.example.test",
    OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM: "example",
    OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID: "openshapeforge-auth-api",
    KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API: "fixture-secret",
    OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE: name,
    OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE_ROLE: "openshapeforge",
  };
  expect(() => readManagedMaintenanceConfiguration(env)).toThrow("HTTPS");
  expect(() =>
    readManagedMaintenanceConfiguration({
      ...env,
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "https://identity.example.test",
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_CONNECT_URL: "http://127.0.0.1",
    }),
  ).toThrow("HTTPS");
  expect(() =>
    readManagedMaintenanceConfiguration({
      ...env,
      OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL: "https://identity.example.test",
      OPENSHAPEFORGE_MCP_CLIENTS: "",
    }),
  ).toThrow("clients");
});
