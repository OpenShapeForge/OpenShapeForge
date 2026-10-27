// SPDX-License-Identifier: BUSL-1.1
/**
 * The integration catalog handlers against the real provisioning service.
 *
 * Nothing in the authorization path is stubbed: `service.ts` and `ceiling.ts`
 * run as shipped, Kysely compiles the real statements, and the fixture
 * connection below answers them while ENFORCING the tenant parameter — so a
 * missing tenant predicate shows up as another tenant's rows rather than as a
 * passing test. What is faked is the wire to Postgres and nothing else.
 *
 * Every result is checked against the compiled contract the transports use
 * (`listOperationContracts`), because a handler that returns the right data in
 * the wrong shape is a HANDLER_CONTRACT_VIOLATION at runtime, not a bug anyone
 * sees in review.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import type { ModuleOperationContext, ModuleOperationResult } from "../modules/contract.js";
import { apiKeyOperationHandler, apiKeyOperationHandlerNames, credentialStatus } from "./api-key-operations.js";
import { createOperationAjv } from "./operation-ajv.js";
import { listOperationContracts } from "./runtime.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const MANAGER = "33333333-3333-4333-8333-333333333333";
const MANAGE_ROLE = "Platform.ApiKeys.Manage";
const READ_ROLE = "Relations.All.Read";
const WRITE_ROLE = "Relations.All.ReadWrite";

const INTEGRATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const INTEGRATION_A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const INTEGRATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const KEY_LIVE = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const KEY_REVOKED = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const KEY_EXPIRED = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const KEY_OTHER_INTEGRATION = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4";

const NOW = new Date("2026-10-27T12:00:00.000Z");

type IntegrationRow = {
  id: string;
  tenantId: string;
  displayName: string;
  status: "pending" | "active" | "disabled";
  grantedRoles: string[];
  createdAt: Date;
  updatedAt: Date;
};

type KeyRow = {
  id: string;
  tenantId: string;
  integrationId: string;
  displayName: string;
  roleSubset: string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

function fixtureStore() {
  const integrations: IntegrationRow[] = [
    {
      id: INTEGRATION_A, tenantId: TENANT_A, displayName: "Payroll sync", status: "active",
      grantedRoles: [READ_ROLE, WRITE_ROLE],
      createdAt: new Date("2026-01-02T00:00:00.000Z"), updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    },
    {
      id: INTEGRATION_A2, tenantId: TENANT_A, displayName: "Analytics export", status: "disabled",
      grantedRoles: [READ_ROLE],
      createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-03-03T00:00:00.000Z"),
    },
    {
      id: INTEGRATION_B, tenantId: TENANT_B, displayName: "Another tenant's partner", status: "active",
      grantedRoles: [READ_ROLE],
      createdAt: new Date("2026-01-03T00:00:00.000Z"), updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    },
  ];
  const keys: KeyRow[] = [
    {
      id: KEY_LIVE, tenantId: TENANT_A, integrationId: INTEGRATION_A, displayName: "Live key",
      roleSubset: [READ_ROLE], createdAt: new Date("2026-03-01T00:00:00.000Z"),
      expiresAt: new Date("2027-03-01T00:00:00.000Z"), revokedAt: null,
      lastUsedAt: new Date("2026-10-20T00:00:00.000Z"),
    },
    {
      id: KEY_REVOKED, tenantId: TENANT_A, integrationId: INTEGRATION_A, displayName: "Retired key",
      roleSubset: null, createdAt: new Date("2026-02-01T00:00:00.000Z"),
      expiresAt: null, revokedAt: new Date("2026-04-01T00:00:00.000Z"), lastUsedAt: null,
    },
    {
      id: KEY_EXPIRED, tenantId: TENANT_A, integrationId: INTEGRATION_A, displayName: "Lapsed key",
      roleSubset: null, createdAt: new Date("2026-01-15T00:00:00.000Z"),
      expiresAt: new Date("2026-06-01T00:00:00.000Z"), revokedAt: null, lastUsedAt: null,
    },
    {
      id: KEY_OTHER_INTEGRATION, tenantId: TENANT_A, integrationId: INTEGRATION_A2,
      displayName: "Analytics key", roleSubset: null, createdAt: new Date("2026-02-15T00:00:00.000Z"),
      expiresAt: null, revokedAt: null, lastUsedAt: null,
    },
  ];
  return { integrations, keys };
}

type Store = ReturnType<typeof fixtureStore>;

function live(key: KeyRow, now: Date): boolean {
  return key.revokedAt === null && (key.expiresAt === null || key.expiresAt.getTime() > now.getTime());
}

/**
 * Answer one compiled statement from the fixture store.
 *
 * The tenant id is matched for every statement that reaches an api-key table.
 * That is this fixture's whole point: it stands in for the RLS policy and the
 * explicit predicate, so a read that forgot either would return rows here and
 * fail the cross-tenant tests rather than quietly pass.
 */
function answer(store: Store, text: string, params: readonly unknown[]): unknown[] {
  const named = (value: string) => params.includes(value);
  const integrationRow = (row: IntegrationRow) => ({
    id: row.id, display_name: row.displayName, status: row.status,
    granted_roles: row.grantedRoles, created_at: row.createdAt, updated_at: row.updatedAt,
    key_count: String(store.keys.filter((key) => key.integrationId === row.id).length),
    active_key_count: String(
      store.keys.filter((key) => key.integrationId === row.id && live(key, NOW)).length,
    ),
  });
  const keyRow = (row: KeyRow) => ({
    id: row.id, integration_id: row.integrationId,
    integration_name: store.integrations.find((item) => item.id === row.integrationId)?.displayName ?? "",
    display_name: row.displayName, role_subset: row.roleSubset, created_at: row.createdAt,
    expires_at: row.expiresAt, revoked_at: row.revokedAt, last_used_at: row.lastUsedAt,
  });

  if (text.includes("set_config(")) return [];

  if (text.includes("update platform.api_keys k")) {
    const key = store.keys.find((row) => named(row.id) && named(row.tenantId));
    if (!key) return [];
    key.revokedAt = key.revokedAt ?? NOW;
    return [{ id: key.id, revoked_at: key.revokedAt }];
  }
  if (text.includes("update platform.api_key_integrations")) {
    const integration = store.integrations.find((row) => named(row.id) && named(row.tenantId));
    if (!integration) return [];
    integration.status = "disabled";
    return [{ id: integration.id }];
  }
  if (text.includes("update platform.api_keys")) {
    const revoked = store.keys.filter((row) =>
      named(row.integrationId) && named(row.tenantId) && row.revokedAt === null
    );
    for (const key of revoked) key.revokedAt = NOW;
    return revoked.map((row) => ({ id: row.id }));
  }
  if (text.includes("insert into platform.api_keys")) return [];
  if (text.includes("select id, granted_roles")) {
    const integration = store.integrations.find((row) =>
      named(row.id) && named(row.tenantId) && row.status === "active"
    );
    return integration ? [{ id: integration.id, granted_roles: integration.grantedRoles }] : [];
  }
  if (text.includes("group by i.id")) {
    const rows = store.integrations.filter((row) => named(row.tenantId));
    const scoped = text.includes("and i.id =") ? rows.filter((row) => named(row.id)) : rows;
    return scoped
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en"))
      .map(integrationRow);
  }
  if (text.includes("from platform.api_keys k")) {
    const rows = store.keys.filter((row) => named(row.tenantId));
    const byIntegration = text.includes("k.integration_id =")
      ? rows.filter((row) => named(row.integrationId))
      : rows;
    const scoped = text.includes("k.id =") ? byIntegration.filter((row) => named(row.id)) : byIntegration;
    return scoped
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(keyRow);
  }
  return [];
}

function fixtureDatabase(store: Store) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query);
      return { rows: answer(store, query.sql, query.parameters) as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("Unexpected stream.");
    },
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        async init() {}, async acquireConnection() { return connection; },
        async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
        async releaseConnection() {}, async destroy() {},
      }),
    },
  });
  return { db, statements };
}

function sessionFor(overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext {
  return {
    tenantId: TENANT_A,
    userId: MANAGER,
    roles: [MANAGE_ROLE, READ_ROLE, WRITE_ROLE],
    groups: [],
    scope: "tenant",
    credential: "bearer",
    ...overrides,
  };
}

const ajv = createOperationAjv();
const contracts = new Map(listOperationContracts()
  .filter((operation) => operation.plugin === "osf-api-keys")
  .map((operation) => [operation.handler, operation]));

/** The runtime's own default error body shape; a handler must match it exactly. */
const errorValidator = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable"],
      properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" } },
    },
  },
});

type Invocation = {
  store?: Store;
  session?: TrustedSessionContext | undefined;
  db?: OpenShapeForgeDatabase | undefined;
  withoutDatabase?: boolean;
};

/**
 * Invoke one handler and hold its result to the compiled contract: input
 * against the declared input schema, a success value against the declared
 * output schema, a refusal against the declared status/code pairs.
 */
async function run(
  handler: string,
  input: Record<string, unknown>,
  options: Invocation = {},
): Promise<{ result: ModuleOperationResult; statements: CompiledQuery[] }> {
  const contract = contracts.get(handler)!;
  expect(ajv.validate(contract.inputSchema, { ...input })).toBe(true);
  const store = options.store ?? fixtureStore();
  const { db, statements } = fixtureDatabase(store);
  const context = {
    transport: "operation",
    ...(options.withoutDatabase ? {} : { db: options.db ?? (db as unknown as OpenShapeForgeDatabase) }),
    ...("session" in options ? { session: options.session } : { session: sessionFor() }),
  } as unknown as ModuleOperationContext;
  const result = await apiKeyOperationHandler({ key: contract.key, handler })(input, context);
  if ("ok" in result && result.ok === false) {
    const declared = contract.errors.some((error) =>
      error.status === result.status && error.code === result.code
    );
    expect({ status: result.status, code: result.code, declared }).toMatchObject({ declared: true });
    expect(errorValidator(result.body)).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain("osf_");
  } else {
    expect(ajv.validate(contract.outputSchema, (result as { value: unknown }).value)).toBe(true);
  }
  return { result, statements };
}

function value(result: ModuleOperationResult): Record<string, any> {
  expect("ok" in result && result.ok === false).toBe(false);
  return (result as { value: Record<string, any> }).value;
}

function failure(result: ModuleOperationResult): { status: number; code: string; message: string } {
  expect("ok" in result && result.ok === false).toBe(true);
  const error = result as { status: number; code: string; body: { error: { message: string } } };
  return { status: error.status, code: error.code, message: error.body.error.message };
}

const PROVISIONING_ENV = {
  OPENSHAPEFORGE_API_KEY_SECRET_KEYS: `test:${randomBytes(32).toString("base64")}`,
  OPENSHAPEFORGE_KEYCLOAK_BASE_URL: "http://keycloak.invalid",
  OPENSHAPEFORGE_KEYCLOAK_REALM: "openshapeforge",
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID: "provisioner",
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET: "provisioner-secret",
} as const;

const previous = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [name, setting] of Object.entries(PROVISIONING_ENV)) {
    previous.set(name, process.env[name]);
    process.env[name] = setting;
  }
});

afterEach(() => {
  for (const [name, setting] of previous) {
    if (setting === undefined) delete process.env[name];
    else process.env[name] = setting;
  }
  previous.clear();
});

describe("integration catalog Operations", () => {
  test("binds exactly the handlers the compiled catalog declares", () => {
    expect(apiKeyOperationHandlerNames()).toEqual([
      "disableIntegration", "getCredential", "getIntegration", "issueCredential",
      "listCredentials", "listIntegrations", "revokeCredential",
    ]);
    expect([...contracts.keys()].sort()).toEqual([...apiKeyOperationHandlerNames()]);
    expect(() => apiKeyOperationHandler({ key: "api-keys.unknown", handler: "mintEverything" }))
      .toThrow(/Unknown core API key catalog handler/);
  });

  test("lists this tenant's integrations with their key counts, and nothing of another tenant", async () => {
    const { result, statements } = await run("listIntegrations", {});
    const page = value(result);
    expect(page.totalCount).toBe(2);
    expect(page.nextCursor).toBeNull();
    expect(page.integrations.map((row: any) => row.displayName)).toEqual(["Analytics export", "Payroll sync"]);
    expect(page.integrations[1]).toMatchObject({
      integrationId: INTEGRATION_A,
      status: "active",
      grantedRoles: [READ_ROLE, WRITE_ROLE],
      credentialCount: 3,
      // Live only: the revoked and the lapsed key are not active credentials.
      activeCredentialCount: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    // The realm's own identifiers are never projected; the stable row id is.
    expect(JSON.stringify(page)).not.toContain("osf-int-");
    expect(JSON.stringify(page)).not.toContain(INTEGRATION_B);
    // Every statement that touched an api-key table carried the tenant.
    const reads = statements.filter((query) => query.sql.includes("platform.api_key"));
    expect(reads.length).toBeGreaterThan(0);
    for (const query of reads) expect(query.parameters).toContain(TENANT_A);
    for (const query of reads) {
      expect(query.sql).not.toContain("secret_hash");
      expect(query.sql).not.toContain("lookup_id");
      expect(query.sql).not.toContain("client_secret");
    }
  });

  test("reads one integration by its stable id, and reports another tenant's as absent", async () => {
    const mine = value((await run("getIntegration", { integrationId: INTEGRATION_A })).result);
    expect(mine).toMatchObject({ integrationId: INTEGRATION_A, displayName: "Payroll sync", status: "active" });

    const foreign = failure((await run("getIntegration", { integrationId: INTEGRATION_B })).result);
    expect(foreign).toMatchObject({ status: 404, code: "NOT_FOUND" });

    // The mirror image: a manager of the other tenant cannot read ours either.
    const theirs = failure((await run(
      "getIntegration",
      { integrationId: INTEGRATION_A },
      { session: sessionFor({ tenantId: TENANT_B }) },
    )).result);
    expect(theirs).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("lists one integration's credentials as metadata, with no key material anywhere", async () => {
    const { result } = await run("listCredentials", { integrationId: INTEGRATION_A });
    const page = value(result);
    expect(page.totalCount).toBe(3);
    expect(page.credentials.map((row: any) => ({ id: row.id, status: row.status }))).toEqual([
      { id: KEY_LIVE, status: "active" },
      { id: KEY_REVOKED, status: "revoked" },
      { id: KEY_EXPIRED, status: "expired" },
    ]);
    expect(page.credentials[0]).toMatchObject({
      integrationId: INTEGRATION_A,
      integrationName: "Payroll sync",
      roleSubset: [READ_ROLE],
      lastUsedAt: "2026-10-20T00:00:00.000Z",
    });
    for (const credential of page.credentials) {
      expect(Object.keys(credential).sort()).toEqual([
        "createdAt", "displayName", "expiresAt", "id", "integrationId", "integrationName",
        "lastUsedAt", "revokedAt", "roleSubset", "status",
      ]);
    }
    // Credentials of a sibling integration are not in this collection, and a
    // foreign integration is absent rather than empty.
    expect(page.credentials.map((row: any) => row.id)).not.toContain(KEY_OTHER_INTEGRATION);
    expect(failure((await run("listCredentials", { integrationId: INTEGRATION_B })).result))
      .toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("binds a credential read to the integration it was opened on", async () => {
    const own = value((await run("getCredential", { id: KEY_LIVE, integrationId: INTEGRATION_A })).result);
    expect(own).toMatchObject({ id: KEY_LIVE, integrationId: INTEGRATION_A, status: "active" });

    // The key exists and is this tenant's, but belongs to another integration:
    // the nested read must not let a caller walk out of its subject.
    const crossed = await run("getCredential", {
      id: KEY_OTHER_INTEGRATION,
      integrationId: INTEGRATION_A,
    });
    expect(failure(crossed.result)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(crossed.statements.some((query) =>
      query.sql.includes("k.integration_id =") && query.parameters.includes(INTEGRATION_A)
    )).toBe(true);
  });

  test("pages and sorts the declared collection contract, and refuses a cursor it never issued", async () => {
    const store = fixtureStore();
    const firstPage = value((await run(
      "listCredentials",
      { integrationId: INTEGRATION_A, first: 2, sortField: "createdAt", sortDirection: "asc" },
      { store },
    )).result);
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.credentials.map((row: any) => row.id)).toEqual([KEY_EXPIRED, KEY_REVOKED]);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = value((await run(
      "listCredentials",
      {
        integrationId: INTEGRATION_A, first: 2, sortField: "createdAt",
        sortDirection: "asc", after: firstPage.nextCursor,
      },
      { store },
    )).result);
    expect(secondPage.credentials.map((row: any) => row.id)).toEqual([KEY_LIVE]);
    expect(secondPage.nextCursor).toBeNull();

    // A free-text filter narrows the same page contract.
    const filtered = value((await run(
      "listCredentials",
      { integrationId: INTEGRATION_A, displayName: "lapsed" },
      { store },
    )).result);
    expect(filtered.totalCount).toBe(1);
    expect(filtered.credentials[0].id).toBe(KEY_EXPIRED);

    const statusFiltered = value((await run(
      "listCredentials",
      { integrationId: INTEGRATION_A, status: "revoked" },
      { store },
    )).result);
    expect(statusFiltered.credentials.map((row: any) => row.id)).toEqual([KEY_REVOKED]);

    for (const after of ["not-a-cursor", Buffer.from("9999", "utf8").toString("base64url")]) {
      expect(failure((await run(
        "listCredentials",
        { integrationId: INTEGRATION_A, after },
        { store },
      )).result)).toMatchObject({ status: 400, code: "VALIDATION" });
    }

    // Integrations page on their own declared default, newest name first.
    const integrations = value((await run(
      "listIntegrations",
      { first: 1, sortField: "updatedAt", sortDirection: "desc" },
      { store },
    )).result);
    expect(integrations.integrations.map((row: any) => row.displayName)).toEqual(["Analytics export"]);
    expect(integrations.totalCount).toBe(2);
    expect(integrations.nextCursor).toBeTruthy();
  });

  test("returns the issued secret exactly once and never from a read", async () => {
    const store = fixtureStore();
    const issued = value((await run(
      "issueCredential",
      { integrationId: INTEGRATION_A, displayName: "Rotation key", roleSubset: [READ_ROLE] },
      { store },
    )).result);
    expect(issued.integrationId).toBe(INTEGRATION_A);
    expect(typeof issued.secret).toBe("string");
    expect(issued.secret.length).toBeGreaterThan(20);
    expect(issued.expiresAt).toBeTruthy();

    // The listing that follows reports the row and not the credential: the
    // stored half is a hash, so there is nothing for a read to return.
    store.keys.push({
      id: issued.id, tenantId: TENANT_A, integrationId: INTEGRATION_A,
      displayName: "Rotation key", roleSubset: [READ_ROLE], createdAt: NOW,
      expiresAt: new Date(issued.expiresAt), revokedAt: null, lastUsedAt: null,
    });
    const listed = value((await run("listCredentials", { integrationId: INTEGRATION_A }, { store })).result);
    expect(listed.totalCount).toBe(4);
    expect(JSON.stringify(listed)).not.toContain(issued.secret);
    const read = value((await run(
      "getCredential",
      { id: issued.id, integrationId: INTEGRATION_A },
      { store },
    )).result);
    expect(JSON.stringify(read)).not.toContain(issued.secret);
    expect(Object.keys(read)).not.toContain("secret");

    // A second issue mints a DIFFERENT credential: rotation, not recovery.
    const again = value((await run(
      "issueCredential",
      { integrationId: INTEGRATION_A, displayName: "Rotation key" },
      { store },
    )).result);
    expect(again.secret).not.toBe(issued.secret);
    expect(again.id).not.toBe(issued.id);
  });

  test("holds the privilege ceiling on the issue path", async () => {
    // A role the caller does not hold cannot be put on a new credential, even
    // though the integration itself holds it.
    const above = failure((await run("issueCredential", {
      integrationId: INTEGRATION_A,
      displayName: "Escalation",
      roleSubset: [WRITE_ROLE],
    }, { session: sessionFor({ roles: [MANAGE_ROLE, READ_ROLE] }) })).result);
    expect(above).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(above.message).toContain(WRITE_ROLE);

    // Without a narrowing the key carries the integration's FULL set, so the
    // same caller is refused for the same reason — the `update`-shaped path is
    // not the weak one.
    expect(failure((await run("issueCredential", {
      integrationId: INTEGRATION_A,
      displayName: "Escalation by omission",
    }, { session: sessionFor({ roles: [MANAGE_ROLE, READ_ROLE] }) })).result))
      .toMatchObject({ status: 403, code: "FORBIDDEN" });

    // An empty narrowing is neither a narrowing nor an absence: refused rather
    // than read back as "the integration's full set".
    expect(failure((await run("issueCredential", {
      integrationId: INTEGRATION_A, displayName: "Empty subset", roleSubset: null,
    }, { session: sessionFor({ roles: [MANAGE_ROLE, READ_ROLE] }) })).result))
      .toMatchObject({ status: 403, code: "FORBIDDEN" });

    // A disabled integration is not an issuing target.
    expect(failure((await run("issueCredential", {
      integrationId: INTEGRATION_A2, displayName: "Against a disabled integration",
    })).result)).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("refuses every Operation to a session that may not manage keys", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["listIntegrations", {}],
      ["getIntegration", { integrationId: INTEGRATION_A }],
      ["listCredentials", { integrationId: INTEGRATION_A }],
      ["getCredential", { id: KEY_LIVE, integrationId: INTEGRATION_A }],
      ["issueCredential", { integrationId: INTEGRATION_A, displayName: "Nope" }],
      ["revokeCredential", { id: KEY_LIVE }],
      ["disableIntegration", { integrationId: INTEGRATION_A }],
    ];
    for (const [handler, input] of calls) {
      // No management role at all.
      expect(failure((await run(handler, input, {
        session: sessionFor({ roles: [READ_ROLE, WRITE_ROLE] }),
      })).result)).toMatchObject({ status: 403, code: "FORBIDDEN" });

      // An API key session, holding the management role. A credential that can
      // mint credentials is a ladder, so reads are refused as well as writes.
      const byKey = failure((await run(handler, input, {
        session: sessionFor({ credential: "api-key" }),
      })).result);
      expect(byKey).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect(byKey.message).toContain("API keys cannot manage API keys");

      // No session, and no tenant.
      expect(failure((await run(handler, input, { session: undefined })).result))
        .toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
      expect(failure((await run(handler, input, {
        session: sessionFor({ tenantId: null }),
      })).result)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    }
  });

  test("reports an unconfigured deployment rather than half-managing it", async () => {
    for (const missing of Object.keys(PROVISIONING_ENV)) {
      const saved = process.env[missing];
      delete process.env[missing];
      const refusal = failure((await run("listIntegrations", {})).result);
      expect(refusal).toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
      // The refusal says that provisioning is unconfigured, never which
      // variable is missing.
      expect(refusal.message).not.toContain(missing);
      process.env[missing] = saved!;
    }
    // Configuration is checked before the session, so an unconfigured
    // deployment answers the same way to everyone.
    expect(failure((await run("getIntegration", { integrationId: INTEGRATION_A }, {
      withoutDatabase: true,
      session: sessionFor({ roles: [] }),
    })).result)).toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
  });

  test("revokes one credential idempotently and reports the instant it now holds", async () => {
    const store = fixtureStore();
    const first = value((await run("revokeCredential", { id: KEY_LIVE }, { store })).result);
    expect(first).toMatchObject({ id: KEY_LIVE, status: "revoked", revokedAt: NOW.toISOString() });
    // The row survives: it is the only evidence the credential existed.
    expect(store.keys.find((key) => key.id === KEY_LIVE)).toBeDefined();

    const again = value((await run("revokeCredential", { id: KEY_LIVE }, { store })).result);
    expect(again.revokedAt).toBe(first.revokedAt);

    // Another tenant's credential is absent, not revocable.
    const other = fixtureStore();
    other.keys.push({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", tenantId: TENANT_B, integrationId: INTEGRATION_B,
      displayName: "Theirs", roleSubset: null, createdAt: NOW, expiresAt: null,
      revokedAt: null, lastUsedAt: null,
    });
    expect(failure((await run(
      "revokeCredential",
      { id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1" },
      { store: other },
    )).result)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(other.keys.at(-1)!.revokedAt).toBeNull();
  });

  test("disables an integration, revokes its live credentials and counts only those", async () => {
    const store = fixtureStore();
    const disabled = value((await run("disableIntegration", { integrationId: INTEGRATION_A }, { store })).result);
    // Three keys exist under it, one of them already revoked: the live one and
    // the lapsed one are stamped now, because expiry is not revocation.
    expect(disabled).toEqual({
      integrationId: INTEGRATION_A,
      status: "disabled",
      revokedCredentials: 2,
    });
    expect(store.integrations.find((row) => row.id === INTEGRATION_A)!.status).toBe("disabled");
    expect(store.keys.filter((key) => key.integrationId === INTEGRATION_A)
      .every((key) => key.revokedAt !== null)).toBe(true);

    // Repeating it changes nothing and says so.
    expect(value((await run("disableIntegration", { integrationId: INTEGRATION_A }, { store })).result))
      .toMatchObject({ revokedCredentials: 0 });

    // A sibling integration of the same tenant is untouched.
    expect(store.keys.find((key) => key.id === KEY_OTHER_INTEGRATION)!.revokedAt).toBeNull();

    expect(failure((await run("disableIntegration", { integrationId: INTEGRATION_B }, { store })).result))
      .toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("derives credential status from the two instants it is given", () => {
    const at = new Date("2026-10-27T12:00:00.000Z");
    expect(credentialStatus({ revokedAt: null, expiresAt: null }, at)).toBe("active");
    expect(credentialStatus({ revokedAt: null, expiresAt: new Date("2027-01-01T00:00:00Z") }, at)).toBe("active");
    expect(credentialStatus({ revokedAt: null, expiresAt: at }, at)).toBe("expired");
    // Revocation wins over an expiry that has not arrived yet.
    expect(credentialStatus({ revokedAt: at, expiresAt: new Date("2027-01-01T00:00:00Z") }, at)).toBe("revoked");
  });
});
