// SPDX-License-Identifier: BUSL-1.1
/**
 * The integration catalog handlers against the real provisioning service.
 *
 * Nothing in the authorization path is stubbed: `service.ts` and `ceiling.ts`
 * run as shipped, Kysely compiles the real statements, and the fixture
 * connection answers them while ENFORCING the tenant parameter — so a read
 * that lost its predicate returns another tenant's rows rather than passing.
 * Creating an integration goes through the real `KeycloakAdmin` against a stub
 * realm over real HTTP, so the realm half of that path is exercised too.
 *
 * Every result is checked against the compiled contract the transports use
 * (`listOperationContracts`), because a handler that returns the right data in
 * the wrong shape is a HANDLER_CONTRACT_VIOLATION at runtime, not a bug anyone
 * sees in review.
 *
 * What is NOT asserted here is SQL behaviour. Ordering, keyset paging, ties
 * and the parent row lock under concurrency are database properties and are
 * proven against a real PostgreSQL in `api-key-catalog-db.test.ts`. These
 * tests assert the statements that were SENT — the fence, the parameters, the
 * bounds, the lock — and the projection of the rows that came back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { CompiledQuery } from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  apiKeyStatements,
  fixtureDatabase,
  fixtureStore,
  stubRealm,
  type FixtureStore,
  type StubRealm,
} from "../auth/api-key/__tests__/fixtures.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { ModuleOperationContext, ModuleOperationResult } from "../modules/contract.js";
import {
  apiKeyOperationHandler,
  apiKeyOperationHandlerNames,
  credentialStatus,
  MAX_CREDENTIAL_TTL_DAYS,
  ONE_TIME_CREDENTIAL_HEADERS,
} from "./api-key-operations.js";
import { MAX_DISPLAY_NAME_LENGTH } from "../auth/api-key/service.js";
import { MAX_CURSOR_LENGTH } from "./api-key-cursor.js";
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

const NOW = new Date("2026-10-28T12:00:00.000Z");

function populated(): FixtureStore {
  return fixtureStore(
    [
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
    ],
    [
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
    ],
  );
}

/**
 * A verified human administrator holding every role the fixtures mention.
 *
 * `principalKind: null` means ABSENT rather than unset, which is a case in its
 * own right: the bearer path leaves it off for a token whose principal it
 * could not name, and the ceiling has to fail closed on exactly that.
 */
function sessionFor(
  overrides: Partial<Omit<TrustedSessionContext, "principalKind">>
    & { principalKind?: "person" | "service" | null } = {},
): TrustedSessionContext {
  const { principalKind = "person", ...rest } = overrides;
  const session: TrustedSessionContext = {
    tenantId: TENANT_A,
    userId: MANAGER,
    roles: [MANAGE_ROLE, READ_ROLE, WRITE_ROLE],
    groups: [],
    scope: "tenant",
    credential: "bearer",
    ...rest,
  };
  return principalKind === null ? session : { ...session, principalKind };
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
  store?: FixtureStore;
  session?: TrustedSessionContext | undefined;
  withoutDatabase?: boolean;
  /** Skip the input-schema precheck for inputs that are meant to be refused. */
  invalidInput?: boolean;
};

type Invoked = { result: ModuleOperationResult; statements: CompiledQuery[]; store: FixtureStore };

/**
 * Invoke one handler and hold its result to the compiled contract: input
 * against the declared input schema, a success value against the declared
 * output schema, a refusal against the declared status/code pairs.
 */
async function run(
  handler: string,
  input: Record<string, unknown>,
  options: Invocation = {},
): Promise<Invoked> {
  const contract = contracts.get(handler)!;
  if (!options.invalidInput) expect(ajv.validate(contract.inputSchema, { ...input })).toBe(true);
  const store = options.store ?? populated();
  const { db, statements } = fixtureDatabase(store, NOW);
  const context = {
    transport: "operation",
    ...(options.withoutDatabase ? {} : { db: db as unknown as OpenShapeForgeDatabase }),
    ...("session" in options ? { session: options.session } : { session: sessionFor() }),
  } as unknown as ModuleOperationContext;
  const result = await apiKeyOperationHandler({ key: contract.key, handler })(input, context);
  if ("ok" in result && result.ok === false) {
    const declared = contract.errors.some((error) =>
      error.status === result.status && error.code === result.code
    );
    expect({ status: result.status, code: result.code, declared }).toMatchObject({ declared: true });
    expect(errorValidator(result.body)).toBe(true);
  } else {
    expect(ajv.validate(contract.outputSchema, (result as { value: unknown }).value)).toBe(true);
  }
  return { result, statements, store };
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

let realm: StubRealm;

const PROVISIONING_ENV: Record<string, string> = {
  OPENSHAPEFORGE_API_KEY_SECRET_KEYS: `test:${randomBytes(32).toString("base64")}`,
  OPENSHAPEFORGE_KEYCLOAK_BASE_URL: "http://127.0.0.1:1",
  OPENSHAPEFORGE_KEYCLOAK_REALM: "openshapeforge",
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID: "provisioner",
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET: "provisioner-secret",
  OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID: "erp-provider",
};

const previous = new Map<string, string | undefined>();

beforeEach(() => {
  realm = stubRealm({ roles: [READ_ROLE, WRITE_ROLE] });
  PROVISIONING_ENV.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = realm.baseUrl;
  for (const [name, setting] of Object.entries(PROVISIONING_ENV)) {
    previous.set(name, process.env[name]);
    process.env[name] = setting;
  }
});

afterEach(async () => {
  for (const [name, setting] of previous) {
    if (setting === undefined) delete process.env[name];
    else process.env[name] = setting;
  }
  previous.clear();
  await realm.stop();
});

describe("integration catalog Operations", () => {
  test("binds exactly the handlers the compiled catalog declares", () => {
    expect(apiKeyOperationHandlerNames()).toEqual([
      "createIntegration", "disableIntegration", "getCredential", "getIntegration",
      "issueCredential", "listCredentials", "listIntegrations", "revokeCredential",
    ]);
    expect([...contracts.keys()].sort()).toEqual([...apiKeyOperationHandlerNames()]);
    expect(() => apiKeyOperationHandler({ key: "api-keys.unknown", handler: "mintEverything" }))
      .toThrow(/Unknown core API key catalog handler/);
  });

  describe("creating an integration", () => {
    test("provisions the realm identity and hands over the first credential once", async () => {
      const store = fixtureStore();
      // The handler stamps the expiry from its own clock, so the lifetime is
      // asserted against a window around the call rather than a fixed instant.
      const before = Date.now();
      const { result, statements } = await run("createIntegration", {
        displayName: "  Partner portal  ",
        roles: [READ_ROLE, WRITE_ROLE],
        expiresInDays: 90,
        roleSubset: [READ_ROLE],
      }, { store });
      const after = Date.now();
      const created = value(result);

      // Metadata and credential are separate branches, and the metadata is the
      // written row's own: the name is trimmed, the status is the one the
      // service flipped to and the roles are the ones it stored, none of them
      // echoed from the input.
      expect(created.integration).toEqual({
        integrationId: store.integrations[0]!.id,
        displayName: "Partner portal",
        status: "active",
        grantedRoles: [READ_ROLE, WRITE_ROLE],
        createdAt: store.integrations[0]!.createdAt.toISOString(),
      });

      // Nothing touches the database after the key row is inserted. That is
      // the point, not an incidental ordering: the plaintext credential exists
      // exactly once, in this result, so a statement between inserting it and
      // returning it is a step that can fail and lose it while the mint has
      // already committed — and whose retry provisions a second realm client
      // and a second credential. The metadata above comes from the activation
      // statement's own RETURNING instead.
      const mint = statements.findLastIndex((query) =>
        query.sql.includes("insert into platform.api_keys"));
      expect(mint).toBeGreaterThanOrEqual(0);
      expect(statements.slice(mint + 1).map((query) => query.sql.trim())).toEqual([]);
      expect(Object.keys(created.integration)).not.toContain("secret");
      expect(Object.keys(created.credential).sort()).toEqual(["expiresAt", "id", "secret"]);
      expect(typeof created.credential.secret).toBe("string");
      expect(created.credential.secret.length).toBeGreaterThan(20);
      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      const expiry = Date.parse(created.credential.expiresAt);
      expect(expiry).toBeGreaterThanOrEqual(before + ninetyDays);
      expect(expiry).toBeLessThanOrEqual(after + ninetyDays);

      // The realm was really provisioned, in the order the service documents:
      // the client, then the tenant stamp, then the roles.
      expect(realm.requests.filter((request) =>
        request === "POST /admin/realms/openshapeforge/clients")).toHaveLength(1);
      expect(realm.requests.some((request) => request.startsWith("PUT /admin/realms/openshapeforge/users/")))
        .toBe(true);
      expect(realm.requests.some((request) => request.includes("/role-mappings/clients/"))).toBe(true);

      // The realm client id is derived, never taken from the caller.
      const insert = statements.find((query) => query.sql.includes("insert into platform.api_key_integrations"))!;
      expect(insert.parameters).toContain(`osf-int-${store.integrations[0]!.id}`);
      expect(JSON.stringify(insert.parameters)).not.toContain("Partner portal  ");

      // Every statement carried the tenant, and none named a secret column.
      for (const query of apiKeyStatements(statements)) {
        expect(query.parameters).toContain(TENANT_A);
      }
      // The insert necessarily writes the HASH and the public lookup half; no
      // read ever selects either of them back.
      for (const query of statements.filter((candidate) => /^\s*select/i.test(candidate.sql))) {
        expect(query.sql).not.toContain("secret_hash");
        expect(query.sql).not.toContain("lookup_id");
      }
      // And the plaintext secret never travels in any statement, text or
      // parameters: what is stored is its hash.
      const rendered = JSON.stringify(statements.map((query) => [query.sql, query.parameters]));
      expect(rendered).not.toContain(created.credential.secret);
    });

    test("marks the response uncacheable", async () => {
      const { result } = await run("createIntegration", {
        displayName: "Cacheable?", roles: [READ_ROLE],
      }, { store: fixtureStore() });
      expect((result as { headers?: Record<string, string> }).headers).toEqual({
        "cache-control": "private, no-store, max-age=0",
        pragma: "no-cache",
      });
      expect(ONE_TIME_CREDENTIAL_HEADERS["cache-control"]).toContain("no-store");
    });

    test("holds the privilege ceiling on the roles it would grant", async () => {
      const store = fixtureStore();
      const refused = failure((await run("createIntegration", {
        displayName: "Escalation", roles: [READ_ROLE, WRITE_ROLE],
      }, { store, session: sessionFor({ roles: [MANAGE_ROLE, READ_ROLE] }) })).result);
      expect(refused).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect(refused.message).toContain(WRITE_ROLE);
      // Refused BEFORE anything exists: no row, no realm call.
      expect(store.integrations).toEqual([]);
      expect(realm.requests).toEqual([]);

      // The first credential's narrowing is bounded too, not just the
      // integration's own roles.
      const narrowed = failure((await run("createIntegration", {
        displayName: "Escalation by subset", roles: [READ_ROLE], roleSubset: [WRITE_ROLE],
      }, { store, session: sessionFor({ roles: [MANAGE_ROLE, READ_ROLE] }) })).result);
      expect(narrowed).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect(narrowed.message).toContain(WRITE_ROLE);
      expect(store.integrations).toEqual([]);
    });

    test("reports a refused realm without handing anything out", async () => {
      await realm.stop();
      realm = stubRealm({ roles: [READ_ROLE], failClientCreation: true });
      process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = realm.baseUrl;
      const store = fixtureStore();
      const refused = failure((await run("createIntegration", {
        displayName: "Realm says no", roles: [READ_ROLE],
      }, { store })).result);
      expect(refused).toMatchObject({ status: 502, code: "PROVISIONING_FAILED" });
      // The intent row survives at 'pending' — it authenticates nothing and is
      // what the reconciler sweeps — and NO credential was minted.
      expect(store.integrations).toHaveLength(1);
      expect(store.integrations[0]!.status).toBe("pending");
      expect(store.keys).toEqual([]);
    });

    test("refuses a role list that is empty or not a list", async () => {
      for (const roles of [[], "Relations.All.Read", [1]]) {
        expect(failure((await run("createIntegration", {
          displayName: "Bad roles", roles,
        }, { store: fixtureStore(), invalidInput: true })).result))
          .toMatchObject({ status: 400, code: "VALIDATION" });
      }
    });
  });

  describe("credential lifetime", () => {
    test("refuses a lifetime beyond the product ceiling, and never a non-expiring one", async () => {
      expect(MAX_CREDENTIAL_TTL_DAYS).toBe(366);
      for (const handler of ["createIntegration", "issueCredential"] as const) {
        const base = handler === "createIntegration"
          ? { displayName: "Too long", roles: [READ_ROLE] }
          : { integrationId: INTEGRATION_A, displayName: "Too long" };
        const store = handler === "createIntegration" ? fixtureStore() : populated();

        // Above the ceiling.
        expect(failure((await run(handler, { ...base, expiresInDays: 367 },
          { store, invalidInput: true })).result))
          .toMatchObject({ status: 400, code: "VALIDATION" });

        // `null` used to reach the service as "never expires". It is now a
        // client error, not a silent widening.
        const nonExpiring = failure((await run(handler, { ...base, expiresInDays: null },
          { store, invalidInput: true })).result);
        expect(nonExpiring).toMatchObject({ status: 400, code: "VALIDATION" });
        expect(nonExpiring.message).toContain("366");

        // Exactly the ceiling is allowed.
        const atCeiling = await run(handler, { ...base, expiresInDays: 366 }, { store });
        expect("ok" in atCeiling.result && atCeiling.result.ok === false).toBe(false);
      }
    });

    test("states the same ceiling in the compiled input schema", () => {
      for (const handler of ["createIntegration", "issueCredential"]) {
        const schema = contracts.get(handler)!.inputSchema as {
          properties: Record<string, Record<string, unknown>>;
        };
        expect(schema.properties.expiresInDays).toMatchObject({
          type: "integer", minimum: 1, maximum: MAX_CREDENTIAL_TTL_DAYS,
        });
      }
    });
  });

  describe("issuing a credential", () => {
    test("returns the secret once, under the parent lock, and never from a read", async () => {
      const store = populated();
      const issued = value((await run("issueCredential", {
        integrationId: INTEGRATION_A, displayName: "Rotation key", roleSubset: [READ_ROLE],
      }, { store })).result);
      expect(issued.integrationId).toBe(INTEGRATION_A);
      expect(Object.keys(issued.credential).sort()).toEqual(["expiresAt", "id", "secret"]);
      expect(issued.credential.expiresAt).toBeTruthy();

      // The parent row was locked before the key was written.
      expect(store.locked).toEqual([INTEGRATION_A]);

      // A listing afterwards reports the row and not the credential.
      const listed = value((await run("listCredentials",
        { integrationId: INTEGRATION_A }, { store })).result);
      expect(JSON.stringify(listed)).not.toContain(issued.credential.secret);
      const read = value((await run("getCredential",
        { id: issued.credential.id, integrationId: INTEGRATION_A }, { store })).result);
      expect(JSON.stringify(read)).not.toContain(issued.credential.secret);
      expect(Object.keys(read)).not.toContain("secret");

      // A second issue mints a DIFFERENT credential: rotation, not recovery.
      const again = value((await run("issueCredential",
        { integrationId: INTEGRATION_A, displayName: "Rotation key" }, { store })).result);
      expect(again.credential.secret).not.toBe(issued.credential.secret);
      expect(again.credential.id).not.toBe(issued.credential.id);
    });

    test("marks the response uncacheable", async () => {
      const { result } = await run("issueCredential",
        { integrationId: INTEGRATION_A, displayName: "Cacheable?" });
      expect((result as { headers?: Record<string, string> }).headers).toEqual({
        "cache-control": "private, no-store, max-age=0",
        pragma: "no-cache",
      });
    });

    test("is not replayable: neither contract carries idempotency", () => {
      for (const handler of ["createIntegration", "issueCredential"]) {
        // A keyed receipt would STORE the result — the secret included — and a
        // natural one would invite a transport to replay the mint.
        expect(contracts.get(handler)!.idempotency.mode).toBe("none");
      }
    });

    test("holds the privilege ceiling on the issue path", async () => {
      const limited = sessionFor({ roles: [MANAGE_ROLE, READ_ROLE] });
      const above = failure((await run("issueCredential", {
        integrationId: INTEGRATION_A, displayName: "Escalation", roleSubset: [WRITE_ROLE],
      }, { session: limited })).result);
      expect(above).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect(above.message).toContain(WRITE_ROLE);

      // Without a narrowing the key carries the integration's FULL set, so the
      // same caller is refused for the same reason.
      expect(failure((await run("issueCredential", {
        integrationId: INTEGRATION_A, displayName: "Escalation by omission",
      }, { session: limited })).result)).toMatchObject({ status: 403, code: "FORBIDDEN" });

      // A disabled integration is not an issuing target, even for a manager.
      expect(failure((await run("issueCredential", {
        integrationId: INTEGRATION_A2, displayName: "Against a disabled integration",
      })).result)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    });
  });

  describe("reads", () => {
    test("fences every statement on the tenant and selects no key material", async () => {
      const { result, statements } = await run("listIntegrations", {});
      const page = value(result);
      expect(page.integrations.map((row: any) => row.integrationId).sort())
        .toEqual([INTEGRATION_A, INTEGRATION_A2].sort());
      expect(JSON.stringify(page)).not.toContain(INTEGRATION_B);
      // Realm internals are never projected; the stable row id is.
      expect(JSON.stringify(page)).not.toContain("osf-int-");

      const reads = apiKeyStatements(statements);
      expect(reads.length).toBeGreaterThan(0);
      for (const query of reads) {
        expect(query.parameters).toContain(TENANT_A);
        expect(query.sql).not.toContain("secret_hash");
        expect(query.sql).not.toContain("lookup_id");
        expect(query.sql).not.toContain("client_secret");
      }
      // The page is bounded in SQL, not after the fact.
      expect(statements.some((query) => /limit \d+/.test(query.sql))).toBe(true);
    });

    test("reports another tenant's integration as absent, in both directions", async () => {
      expect(value((await run("getIntegration", { integrationId: INTEGRATION_A })).result))
        .toMatchObject({ integrationId: INTEGRATION_A, displayName: "Payroll sync", status: "active" });
      expect(failure((await run("getIntegration", { integrationId: INTEGRATION_B })).result))
        .toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(failure((await run("getIntegration", { integrationId: INTEGRATION_A },
        { session: sessionFor({ tenantId: TENANT_B }) })).result))
        .toMatchObject({ status: 404, code: "NOT_FOUND" });
    });

    test("binds a credential page and a credential read to their parent", async () => {
      const { result, statements } = await run("listCredentials", { integrationId: INTEGRATION_A });
      const page = value(result);
      for (const credential of page.credentials) {
        expect(Object.keys(credential).sort()).toEqual([
          "createdAt", "displayName", "expiresAt", "id", "integrationId", "integrationName",
          "lastUsedAt", "revokedAt", "roleSubset", "status",
        ]);
      }
      // The parent is a predicate on the page AND on its count — which are one
      // statement now, so it has to appear in both of its CTEs rather than in
      // two statements (`catalog-page.ts`, `pageStatement`).
      const fenced = statements.filter((query) => query.sql.includes("k.integration_id ="));
      expect(fenced.length).toBeGreaterThanOrEqual(2);
      for (const query of fenced) {
        expect(query.parameters).toContain(INTEGRATION_A);
        expect(query.parameters).toContain(TENANT_A);
      }
      const pageStatement = statements.find((query) => query.sql.includes("page_total as ("));
      expect(pageStatement).toBeTruthy();
      // Once inside `page_total`, once inside `page_rows`.
      expect(pageStatement!.sql.split("k.integration_id =").length - 1)
        .toBeGreaterThanOrEqual(2);

      // A foreign parent is absent rather than an empty page.
      expect(failure((await run("listCredentials", { integrationId: INTEGRATION_B })).result))
        .toMatchObject({ status: 404, code: "NOT_FOUND" });

      // And a credential of a sibling integration cannot be read through this
      // one: the nested read must not let a caller walk out of its subject.
      const crossed = await run("getCredential",
        { id: KEY_OTHER_INTEGRATION, integrationId: INTEGRATION_A });
      expect(failure(crossed.result)).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(crossed.statements.some((query) =>
        query.sql.includes("k.integration_id =") && query.parameters.includes(INTEGRATION_A)
      )).toBe(true);
    });

    test("refuses a cursor issued for a different sort, filter or parent", async () => {
      const store = populated();
      const first = value((await run("listCredentials",
        { integrationId: INTEGRATION_A, first: 1, sortField: "createdAt", sortDirection: "asc" },
        { store })).result);
      // The fixture answers with every matching row, so the probe row makes a
      // next cursor; the keyset SEMANTICS are proven in the database test.
      expect(first.nextCursor).toBeTruthy();
      const cursor = first.nextCursor as string;

      for (const tampered of [
        { sortField: "displayName", sortDirection: "asc" },
        { sortField: "createdAt", sortDirection: "desc" },
        { sortField: "createdAt", sortDirection: "asc", displayName: "live" },
        { sortField: "createdAt", sortDirection: "asc", status: "active" },
      ]) {
        const refused = failure((await run("listCredentials",
          { integrationId: INTEGRATION_A, first: 1, after: cursor, ...tampered },
          { store })).result);
        expect(refused).toMatchObject({ status: 400, code: "VALIDATION" });
      }

      // A cursor from one parent cannot resume a page under another, even in
      // the same tenant.
      expect(failure((await run("listCredentials",
        { integrationId: INTEGRATION_A2, first: 1, after: cursor, sortField: "createdAt", sortDirection: "asc" },
        { store })).result)).toMatchObject({ status: 400, code: "VALIDATION" });

      // A cursor from the credential listing cannot resume the integration one.
      expect(failure((await run("listIntegrations", { first: 1, after: cursor }, { store })).result))
        .toMatchObject({ status: 400, code: "VALIDATION" });

      // Garbage, and a payload that is well-formed base64 but not a cursor.
      for (const after of ["not-a-cursor", Buffer.from("{}", "utf8").toString("base64url")]) {
        expect(failure((await run("listIntegrations", { first: 1, after }, { store })).result))
          .toMatchObject({ status: 400, code: "VALIDATION" });
      }
    });

    test("refuses an unsupported sort rather than answering in another order", async () => {
      for (const handler of ["listIntegrations", "listCredentials"] as const) {
        const input = handler === "listCredentials" ? { integrationId: INTEGRATION_A } : {};
        for (const sortField of ["createdBy", "secret", "lastUsedAt;drop"]) {
          const refused = failure((await run(handler, { ...input, sortField },
            { invalidInput: true })).result);
          expect(refused).toMatchObject({ status: 400, code: "VALIDATION" });
          expect(refused.message).toContain("sortField must be one of");
        }
        expect(failure((await run(handler, { ...input, sortDirection: "sideways" },
          { invalidInput: true })).result)).toMatchObject({ status: 400, code: "VALIDATION" });
        for (const first of [0, 101, 2.5, "10"]) {
          expect(failure((await run(handler, { ...input, first },
            { invalidInput: true })).result)).toMatchObject({ status: 400, code: "VALIDATION" });
        }
      }
    });

    test("declares an `after` bound no cursor it issues can exceed", () => {
      // A declarable bound at all is what the cursor's shape buys. It names
      // the previous page's last row by id, so one cursor is one length; when
      // it carried the row's SORT VALUE its length followed the display name's,
      // and `display_name` is unbounded `text` that two older surfaces accept
      // any length of — the 200-character bound here refused the listing's own
      // `nextCursor` for any name past a short one, and no larger number would
      // have been right either. The decoder's ceiling is derived from the
      // payload; this keeps the declared bound above it, on both listings,
      // rather than leaving two numbers to drift.
      for (const handler of ["listIntegrations", "listCredentials"]) {
        const schema = contracts.get(handler)!.inputSchema as {
          properties: { after: { maxLength: number }; displayName: { maxLength: number } };
        };
        expect({ handler, fits: schema.properties.after.maxLength >= MAX_CURSOR_LENGTH })
          .toEqual({ handler, fits: true });
        expect({ handler, declared: schema.properties.displayName.maxLength })
          .toEqual({ handler, declared: MAX_DISPLAY_NAME_LENGTH });
      }
      // The minting Operations declare the name bound these listings report
      // in `MAX_DISPLAY_NAME_LENGTH`. It is the OPERATION's bound: the
      // dispatcher applies it, and the service deliberately does not, because
      // the REST and GraphQL mounts reached these same functions first and
      // accept any length (see the service's note on the constant).
      for (const handler of ["createIntegration", "issueCredential"]) {
        const schema = contracts.get(handler)!.inputSchema as {
          properties: { displayName: { maxLength: number; minLength: number } };
        };
        expect({ handler, declared: schema.properties.displayName.maxLength })
          .toEqual({ handler, declared: MAX_DISPLAY_NAME_LENGTH });
        expect({ handler, declared: schema.properties.displayName.minLength })
          .toEqual({ handler, declared: 1 });
      }
    });

    test("never offers lastUsedAt sorting on the integration listing", () => {
      // The integration list has no such column; offering it would be a sort
      // the database cannot serve.
      const schema = contracts.get("listIntegrations")!.inputSchema as {
        properties: { sortField: { enum: string[] } };
      };
      expect(schema.properties.sortField.enum).toEqual(["displayName", "status", "createdAt", "updatedAt"]);
    });
  });

  describe("carrier and configuration", () => {
    const everyCall: Array<[string, Record<string, unknown>]> = [
      ["createIntegration", { displayName: "Nope", roles: [READ_ROLE] }],
      ["listIntegrations", {}],
      ["getIntegration", { integrationId: INTEGRATION_A }],
      ["listCredentials", { integrationId: INTEGRATION_A }],
      ["getCredential", { id: KEY_LIVE, integrationId: INTEGRATION_A }],
      ["issueCredential", { integrationId: INTEGRATION_A, displayName: "Nope" }],
      ["revokeCredential", { id: KEY_LIVE }],
      ["disableIntegration", { integrationId: INTEGRATION_A }],
    ];

    test("refuses every Operation to a session that may not manage keys", async () => {
      for (const [handler, input] of everyCall) {
        // No management role at all.
        expect(failure((await run(handler, input, {
          session: sessionFor({ roles: [READ_ROLE, WRITE_ROLE] }),
        })).result)).toMatchObject({ status: 403, code: "FORBIDDEN" });

        // An API key session holding the management role: a credential that
        // can mint credentials is a ladder, so reads are refused too.
        const byKey = failure((await run(handler, input, {
          session: sessionFor({ credential: "api-key", principalKind: null }),
        })).result);
        expect(byKey).toMatchObject({ status: 403, code: "FORBIDDEN" });
        expect(byKey.message).toContain("API keys cannot manage API keys");

        // A verified SERVICE principal holding the management role, and a
        // bearer whose principal the verifier could not name.
        for (const principalKind of ["service", null] as const) {
          const refused = failure((await run(handler, input, {
            session: sessionFor({ credential: "bearer", principalKind }),
          })).result);
          expect(refused).toMatchObject({ status: 403, code: "FORBIDDEN" });
          expect(refused.message).toContain("Only a verified person may manage API keys");
        }

        // A platform operator, a capability grant and an in-mesh hop that
        // established no principal class are none of them a tenant manager.
        for (const credential of ["control-bearer", "grant", "trusted-context"] as const) {
          expect(failure((await run(handler, input, {
            session: sessionFor({ credential, principalKind: null }),
          })).result)).toMatchObject({ status: 403, code: "FORBIDDEN" });
        }

        // No session, and a session whose tenant is gone — a revoked tenant
        // reaches the handler as a session without one.
        expect(failure((await run(handler, input, { session: undefined })).result))
          .toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
        expect(failure((await run(handler, input, {
          session: sessionFor({ tenantId: null }),
        })).result)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
      }
    });

    test("admits the deployment's own signed in-mesh hop carrying a person", async () => {
      // apps/web's token-less fallback, with the principal class the signer
      // put inside the bundle's HMAC. Without that class the same carrier is
      // refused below: holding the mesh secret is not authenticating a human.
      const page = value((await run("listIntegrations", {}, {
        session: sessionFor({ credential: "trusted-context", principalKind: "person" }),
      })).result);
      expect(page.integrations).toHaveLength(2);

      const refused = failure((await run("listIntegrations", {}, {
        session: sessionFor({ credential: "trusted-context", principalKind: "service" }),
      })).result);
      expect(refused).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect(refused.message).toContain("Only a verified person may manage API keys");
    });

    test("leaves no side effect behind a refusal", async () => {
      const store = populated();
      const before = JSON.stringify(store);
      for (const [handler, input] of everyCall) {
        await run(handler, input, { store, session: sessionFor({ roles: [] }) });
        await run(handler, input, {
          store, session: sessionFor({ credential: "bearer", principalKind: "service" }),
        });
      }
      expect(JSON.stringify(store)).toBe(before);
      expect(realm.requests).toEqual([]);
    });

    test("reports an unconfigured deployment rather than half-managing it", async () => {
      for (const missing of Object.keys(PROVISIONING_ENV)) {
        // The role client id has a documented default, so its absence does not
        // disable the surface.
        if (missing === "OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID") continue;
        const saved = process.env[missing];
        delete process.env[missing];
        const refusal = failure((await run("listIntegrations", {})).result);
        expect(refusal).toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
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
  });

  describe("mutations", () => {
    test("revokes one credential idempotently and reports the instant it now holds", async () => {
      const store = populated();
      const first = value((await run("revokeCredential", { id: KEY_LIVE }, { store })).result);
      expect(first).toMatchObject({ id: KEY_LIVE, status: "revoked", revokedAt: NOW.toISOString() });
      // The row survives: it is the only evidence the credential existed.
      expect(store.keys.find((key) => key.id === KEY_LIVE)).toBeDefined();
      expect(value((await run("revokeCredential", { id: KEY_LIVE }, { store })).result).revokedAt)
        .toBe(first.revokedAt);

      // Another tenant's credential is absent, not revocable.
      const other = populated();
      other.keys.push({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", tenantId: TENANT_B, integrationId: INTEGRATION_B,
        displayName: "Theirs", roleSubset: null, createdAt: NOW, expiresAt: null,
        revokedAt: null, lastUsedAt: null,
      });
      expect(failure((await run("revokeCredential",
        { id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1" }, { store: other })).result))
        .toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(other.keys.at(-1)!.revokedAt).toBeNull();
    });

    test("disables an integration under the same lock and counts what it revoked", async () => {
      const store = populated();
      const disabled = value((await run("disableIntegration",
        { integrationId: INTEGRATION_A }, { store })).result);
      // Three keys exist under it, one already revoked: the live one and the
      // lapsed one are stamped now, because expiry is not revocation.
      expect(disabled).toEqual({
        integrationId: INTEGRATION_A, status: "disabled", revokedCredentials: 2,
      });
      // The SAME parent lock the issue path takes, taken first.
      expect(store.locked).toEqual([INTEGRATION_A]);
      expect(store.integrations.find((row) => row.id === INTEGRATION_A)!.status).toBe("disabled");
      expect(store.keys.filter((key) => key.integrationId === INTEGRATION_A)
        .every((key) => key.revokedAt !== null)).toBe(true);

      // Repeating it changes nothing and says so; a sibling is untouched.
      expect(value((await run("disableIntegration",
        { integrationId: INTEGRATION_A }, { store })).result))
        .toMatchObject({ revokedCredentials: 0 });
      expect(store.keys.find((key) => key.id === KEY_OTHER_INTEGRATION)!.revokedAt).toBeNull();

      expect(failure((await run("disableIntegration",
        { integrationId: INTEGRATION_B }, { store })).result))
        .toMatchObject({ status: 404, code: "NOT_FOUND" });
    });
  });

  test("derives credential status from the two instants it is given", () => {
    const at = new Date("2026-10-28T12:00:00.000Z");
    expect(credentialStatus({ revokedAt: null, expiresAt: null }, at)).toBe("active");
    expect(credentialStatus({ revokedAt: null, expiresAt: new Date("2027-01-01T00:00:00Z") }, at)).toBe("active");
    expect(credentialStatus({ revokedAt: null, expiresAt: at }, at)).toBe("expired");
    // Revocation wins over an expiry that has not arrived yet.
    expect(credentialStatus({ revokedAt: at, expiresAt: new Date("2027-01-01T00:00:00Z") }, at)).toBe("revoked");
  });
});
