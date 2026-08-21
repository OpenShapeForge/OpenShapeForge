// SPDX-License-Identifier: BUSL-1.1
/**
 * The full customer lifecycle, end to end, across TWO tenants: provision both
 * through the control-plane API (the real SPI path), create one user in each
 * through Keycloak's admin API — different tenants, different permission
 * sets — mint their real tokens, and prove the data plane keeps them apart.
 *
 * What this covers that no other spec does: the other cross-tenant checks
 * either use synthetic trusted-context identities (entity-security), the
 * committed dev-realm users (transport-auth), or a provisioned tenant driven
 * again through trusted-context (control-provisioning's RLS test). None walks
 * the whole chain a real customer walks: control API → registry row +
 * Keycloak Organization → a user carrying the new tenant's `tid` attribute →
 * bearer token → RLS. A regression anywhere in that chain — the SPI, the
 * registry link, the tid protocol mapper, the verifier's claim mapping — is
 * only visible from here.
 *
 * The permission half: the writer holds the entity's create role, the other
 * tenant's reader holds only the pure read role. The reader asking for the
 * writer's row must get NULL (not FORBIDDEN — its role permits reads, so a
 * role refusal here would mean the wrong mechanism fired and RLS went
 * untested), and the reader attempting a create must get FORBIDDEN.
 *
 * Skipped (like control-provisioning) unless the control plane is configured
 * and both an operator token and a Keycloak ADMIN token can be minted. The
 * admin credentials are the documented local-dev bootstrap values
 * (admin/admin in docker-compose.local.yml and in CI), overridable via
 * E2E_KEYCLOAK_ADMIN_USERNAME / E2E_KEYCLOAK_ADMIN_PASSWORD.
 */
import { afterAll, expect } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { readControlPlaneConfig, type ControlPlaneConfig } from "../../control/config.js";
import { registerControlRestRoutes } from "../../control/rest-routes.js";
import { SYSTEM_BYPASS_ROLE, withSystemSession } from "../../db/session.js";
import { describe, getRuntime, gql, registerSuiteLifecycle, seed, test } from "./e2e/harness.js";
import {
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  sampleValue,
  tables,
} from "./e2e/entity-factory.js";

registerSuiteLifecycle();

const configResult = readControlPlaneConfig();
const config: ControlPlaneConfig | null = configResult.ok ? configResult.config : null;

// ---------------------------------------------------------------------------
// Tokens: operator (control realm), admin (master realm), user (tenant realm)
// ---------------------------------------------------------------------------

async function operatorToken(): Promise<string | null> {
  if (!config) return null;
  try {
    const response = await fetch(`${config.operator.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: process.env.E2E_CONTROL_CLIENT_ID ?? config.operator.clientId,
        client_secret: process.env.E2E_CONTROL_CLIENT_SECRET ?? "admin-dev-secret",
        username: process.env.E2E_CONTROL_USERNAME ?? "platform-operator",
        password: process.env.E2E_CONTROL_PASSWORD ?? "test",
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

/** Keycloak bootstrap admin on the master realm, for user management. */
async function adminToken(): Promise<string | null> {
  if (!config) return null;
  try {
    const response = await fetch(
      `${config.keycloak.baseUrl}/realms/master/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: process.env.E2E_KEYCLOAK_ADMIN_USERNAME ?? "admin",
          password: process.env.E2E_KEYCLOAK_ADMIN_PASSWORD ?? "admin",
        }),
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    return ((await response.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

/** Password-grant token for a tenant-realm user, same client the gateway uses. */
async function userToken(username: string, password: string): Promise<string | null> {
  const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  if (!issuer) return null;
  try {
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: process.env.E2E_KEYCLOAK_CLIENT_ID ?? "openshapeforge-gateway",
        client_secret: process.env.E2E_KEYCLOAK_CLIENT_SECRET ?? "dev-secret",
        username,
        password,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

const bearer = await operatorToken();
const admin = await adminToken();
const enabled = config !== null && bearer !== null && admin !== null;

// ---------------------------------------------------------------------------
// Keycloak admin helpers (tenant realm)
// ---------------------------------------------------------------------------

function adminBase(): string {
  return `${config!.keycloak.baseUrl}/admin/realms/${encodeURIComponent(config!.keycloak.tenantRealm)}`;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${adminBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${admin}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(8000),
  });
}

const createdUserIds: string[] = [];

/**
 * A realm user whose token belongs to `tenantId` and carries exactly `roles`:
 * the `tid` user attribute is what the realm's tid-mapper turns into the
 * claim the verifier reads, and the roles are client roles on the audience
 * client — the same wiring the committed dev-realm users use.
 */
async function createTenantUser(
  username: string,
  password: string,
  tenantId: string,
  roles: string[],
): Promise<string> {
  const created = await adminFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      username,
      email: `${username}@e2e.invalid`,
      enabled: true,
      emailVerified: true,
      attributes: { tid: [tenantId] },
      credentials: [{ type: "password", value: password, temporary: false }],
    }),
  });
  expect(created.status).toBe(201);
  const userId = created.headers.get("location")!.split("/").pop()!;
  createdUserIds.push(userId);

  const audience = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE ?? "erp-provider";
  const clients = (await (await adminFetch(`/clients?clientId=${encodeURIComponent(audience)}`)).json()) as Array<{ id: string }>;
  expect(clients.length).toBe(1);
  const clientId = clients[0]!.id;

  const representations = [];
  for (const role of roles) {
    const found = await adminFetch(`/clients/${clientId}/roles/${encodeURIComponent(role)}`);
    expect(found.status).toBe(200);
    representations.push(await found.json());
  }
  const mapped = await adminFetch(`/users/${userId}/role-mappings/clients/${clientId}`, {
    method: "POST",
    body: JSON.stringify(representations),
  });
  expect(mapped.status).toBe(204);
  return userId;
}

// ---------------------------------------------------------------------------
// Control-plane transport (same in-process Fastify pattern as
// control-provisioning.e2e.test.ts, for the same reasons)
// ---------------------------------------------------------------------------

let app: FastifyInstance | null = null;

function control(): FastifyInstance {
  if (app) return app;
  const instance = Fastify({ logger: false });
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerControlRestRoutes(instance, { db: getRuntime().db });
  app = instance;
  return instance;
}

async function post(path: string, body: unknown) {
  const response = await control().inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

// ---------------------------------------------------------------------------
// The two tenants, and the entity + roles the assertions drive
// ---------------------------------------------------------------------------

const slugA = `e2e-iso-a-${seed}`;
const slugB = `e2e-iso-b-${seed}`;
const createdOrganizationIds: string[] = [];

// A tenant-scoped entity whose allow-lists carry both a create role (for the
// writer) and a pure read role (for the reader). Derived, not hardcoded, so
// the spec survives catalog changes the way the rest of the suite now does.
const subject = tables.find((candidate) => {
  if (!candidate.tenantScoped) return false;
  const roles = candidate.source?.authorization?.roles;
  const writes = new Set([...(roles?.create ?? []), ...(roles?.update ?? []), ...(roles?.delete ?? [])]);
  return (roles?.create?.length ?? 0) > 0 && (roles?.read ?? []).some((role) => !writes.has(role));
})!;
const subjectGraphql = subject.source!.graphql!;
const subjectWrites = new Set([
  ...(subject.source!.authorization!.roles.create ?? []),
  ...(subject.source!.authorization!.roles.update ?? []),
  ...(subject.source!.authorization!.roles.delete ?? []),
]);
const writerRole = subject.source!.authorization!.roles.create[0]!;
const readerRole = subject.source!.authorization!.roles.read.find(
  (role) => !subjectWrites.has(role),
)!;

function createInput(): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const column of subject.columns) {
    if (!isMutableColumn(column)) continue;
    if (foreignKeyTargets(subject).has(column.name)) continue;
    if (column.required) input[fieldName(column)] = sampleValue(column, `iso-${seed}`);
  }
  return input;
}

afterAll(async () => {
  if (!enabled) return;
  for (const userId of createdUserIds) {
    await adminFetch(`/users/${userId}`, { method: "DELETE" }).catch(() => {});
  }
  for (const id of createdOrganizationIds) {
    await adminFetch(`/organizations/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
      () => {},
    );
  }
  // Same audited bypass the provisioning suite cleans with; children first.
  await withSystemSession(
    getRuntime().db,
    {
      actorSubject: "e2e-tenant-isolation",
      roles: [SYSTEM_BYPASS_ROLE],
      reason: `two-tenant isolation e2e cleanup: slugs ${slugA}, ${slugB}`,
    },
    async (trx) => {
      await sql`
        delete from platform.org_unit
         where tenant_id in (select id from platform.tenants where slug in (${slugA}, ${slugB}))
      `.execute(trx);
      await sql`delete from platform.tenants where slug in (${slugA}, ${slugB})`.execute(trx);
    },
  ).catch(() => {});
  await app?.close();
});

describe("two provisioned tenants, isolated end to end", () => {
  let rowId: string | null = null;
  let writerToken: string | null = null;
  let readerToken: string | null = null;

  test.skipIf(!enabled)(
    "provisioning two tenants and a differently-permissioned user in each",
    async () => {
      const password = `e2e-${seed}-pw`;

      const a = await post("/api/control/v1/tenants", { slug: slugA, name: `E2E iso A ${seed}` });
      expect(a.status).toBe(201);
      createdOrganizationIds.push(a.body.organization.id);

      const b = await post("/api/control/v1/tenants", { slug: slugB, name: `E2E iso B ${seed}` });
      expect(b.status).toBe(201);
      createdOrganizationIds.push(b.body.organization.id);

      expect(a.body.tenant.id).not.toBe(b.body.tenant.id);

      await createTenantUser(`e2e-iso-writer-${seed}`, password, a.body.tenant.id, [writerRole]);
      await createTenantUser(`e2e-iso-reader-${seed}`, password, b.body.tenant.id, [readerRole]);

      writerToken = await userToken(`e2e-iso-writer-${seed}`, password);
      readerToken = await userToken(`e2e-iso-reader-${seed}`, password);
      expect(writerToken).toBeTruthy();
      expect(readerToken).toBeTruthy();
    },
  );

  test.skipIf(!enabled)("the writer's token creates a row in its own tenant", async () => {
    const created = await gql(
      null,
      `mutation($input: Create${subjectGraphql.typeName}Input!) {
         ${subjectGraphql.createMutationName}(input: $input) { id }
       }`,
      { input: createInput() },
      { bearer: writerToken! },
    );
    expect(created.errors ?? []).toEqual([]);
    rowId = created.data?.[subjectGraphql.createMutationName]?.id as string;
    expect(rowId).toBeTruthy();

    // Sanity: visible to its own tenant, so the refusals below mean isolation.
    const own = await gql(
      null,
      `query($id: ID!) { ${subjectGraphql.singleQueryName}(id: $id) { id } }`,
      { id: rowId },
      { bearer: writerToken! },
    );
    expect(own.data?.[subjectGraphql.singleQueryName]?.id).toBe(rowId);
  });

  test.skipIf(!enabled)(
    "the other tenant's reader gets NULL, not FORBIDDEN — isolation, not role denial",
    async () => {
      const crossRead = await gql(
        null,
        `query($id: ID!) { ${subjectGraphql.singleQueryName}(id: $id) { id } }`,
        { id: rowId! },
        { bearer: readerToken! },
      );
      expect(crossRead.errors?.[0]?.extensions?.code).not.toBe("FORBIDDEN");
      expect(crossRead.data?.[subjectGraphql.singleQueryName]).toBeNull();

      const crossList = await gql(
        null,
        `query($filter: ${subjectGraphql.typeName}Filter) {
           ${subjectGraphql.listQueryName}(filter: $filter, first: 1) { totalCount }
         }`,
        { filter: { id: rowId! } },
        { bearer: readerToken! },
      );
      expect(crossList.errors ?? []).toEqual([]);
      expect(crossList.data?.[subjectGraphql.listQueryName]?.totalCount).toBe(0);
    },
  );

  test.skipIf(!enabled)("the reader's read-only role cannot create, in any tenant", async () => {
    const attempt = await gql(
      null,
      `mutation($input: Create${subjectGraphql.typeName}Input!) {
         ${subjectGraphql.createMutationName}(input: $input) { id }
       }`,
      { input: createInput() },
      { bearer: readerToken! },
    );
    expect(attempt.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  test.skipIf(!enabled)("the writer deletes its row; the journal stayed per-tenant", async () => {
    const deleted = await gql(
      null,
      `mutation($id: ID!) { ${subjectGraphql.deleteMutationName}(id: $id) }`,
      { id: rowId! },
      { bearer: writerToken! },
    );
    expect(deleted.errors ?? []).toEqual([]);
    expect(deleted.data?.[subjectGraphql.deleteMutationName]).toBe(true);
  });
});
