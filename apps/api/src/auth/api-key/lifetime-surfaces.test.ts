// SPDX-License-Identifier: BUSL-1.1
/**
 * The deployment's lifetime rule where a caller actually meets it.
 *
 * `lifetime.test.ts` settles the rule itself; this settles that every minting
 * surface resolves the SAME one and that declaring nothing changes nothing.
 * Both are driven over real HTTP, because the policy travels through the
 * provisioning configuration and each transport builds its own service deps —
 * which is exactly where a rule gets dropped.
 *
 * The "new workflow app" of the brief is not a special case here and must not
 * become one: a workflow application registers as an ordinary integration, so
 * it meets the same two bounds as a partner integration and a reporting job.
 */
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { listOperationContracts, registerOperationRestRoutes } from "../../operations/runtime.js";
import { __resetSessionResolverForTests } from "../identity.js";
import { fixtureDatabase, fixtureStore, stubRealm, type FixtureStore, type StubRealm } from "./__tests__/fixtures.js";
import { PRODUCT_MAX_CREDENTIAL_TTL_DAYS } from "./lifetime.js";
import { API_KEY_MOUNT, registerApiKeyRestRoutes } from "./rest-routes.js";
import { readApiKeyProvisioningConfig } from "./runtime-config.js";

const SECRET = "lifetime-surfaces-context-secret";
const TENANT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "33333333-3333-4333-8333-333333333333";
const MANAGE_ROLE = "Platform.ApiKeys.Manage";
const READ_ROLE = "Relations.All.Read";
const DAY_MS = 24 * 60 * 60 * 1000;

const PROVISIONING_ENV = () => ({
  OPENSHAPEFORGE_API_KEY_SECRET_KEYS: `test:${Buffer.alloc(32, 5).toString("base64")}`,
  OPENSHAPEFORGE_KEYCLOAK_BASE_URL: realm.baseUrl,
  OPENSHAPEFORGE_KEYCLOAK_REALM: realm.realm,
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID: "provisioner",
  OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET: "provisioner-secret",
});

function managerHeaders(): Record<string, string> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, {
    tenantId: TENANT,
    userId: MANAGER,
    roles: [MANAGE_ROLE, READ_ROLE],
    principalKind: "person",
  }, { secret: SECRET });
  return Object.fromEntries(headers.entries());
}

let realm: StubRealm;
let store: FixtureStore;

/** The two minting surfaces on one app, under one declared policy. */
function harness(declared: Record<string, string> = {}): { app: FastifyInstance; store: FixtureStore } {
  store = fixtureStore();
  const { db } = fixtureDatabase(store);
  const database = db as unknown as OpenShapeForgeDatabase;
  const config = readApiKeyProvisioningConfig({ ...PROVISIONING_ENV(), ...declared })!;
  const app = Fastify();
  registerApiKeyRestRoutes(app, { db: database, config });
  // The Operation handler reads the same configuration from the environment.
  Object.assign(process.env, PROVISIONING_ENV(), declared);
  registerOperationRestRoutes(
    app,
    [],
    { db: database },
    listOperationContracts().filter((operation) => operation.plugin === "osf-api-keys"),
  );
  return { app, store };
}

beforeEach(() => {
  realm = stubRealm({ roles: [READ_ROLE] });
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = SECRET;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://identity.test/realms/openshapeforge";
  __resetSessionResolverForTests();
});

afterEach(async () => {
  for (const name of [
    "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET",
    "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
    "OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS",
    "OPENSHAPEFORGE_API_KEY_DEFAULT_TTL_DAYS",
    ...Object.keys(PROVISIONING_ENV()),
  ]) delete process.env[name];
  __resetSessionResolverForTests();
  await realm.stop();
});

/** Register one integration through the long-lived REST mount. */
function createOverRest(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: API_KEY_MOUNT,
    headers: managerHeaders(),
    payload: JSON.stringify({ displayName: "Workflow application", roles: [READ_ROLE], ...body }),
  });
}

/** Register one through the canonical Operation's REST projection. */
function createOverOperation(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/api-key-integrations/create",
    headers: managerHeaders(),
    payload: JSON.stringify({
      displayName: "Workflow application", roles: [READ_ROLE], confirmed: true, ...body,
    }),
  });
}

describe("with no policy declared", () => {
  test("the long-lived mount still issues a credential that never expires", async () => {
    const { app } = harness();
    const created = await createOverRest(app, { expiresInDays: null });
    expect(created.statusCode).toBe(201);
    expect(created.json().expiresAt).toBeNull();
    await app.close();
  });

  test("the long-lived mount still grants a lifetime past the contract's bound", async () => {
    // 3650 days is outside what the canonical Operation will ask for and
    // inside what this mount has always granted. Imposing the contract's
    // bound here would shorten lifetimes nobody asked to shorten.
    const { app } = harness();
    const created = await createOverRest(app, { expiresInDays: 3650 });
    expect(created.statusCode).toBe(201);
    expect(new Date(created.json().expiresAt as string).getTime() - Date.now())
      .toBeGreaterThan(3600 * DAY_MS);
    await app.close();
  });

  test("the canonical Operation still refuses to ask beyond the contract's bound", async () => {
    // The product bound is the contract's own and does not depend on any
    // deployment declaring anything. It is refused by the authored input
    // schema — before the handler, and therefore on every transport — which
    // is why the code is the runtime's input one rather than the service's.
    const { app } = harness();
    const refused = await createOverOperation(app, {
      expiresInDays: PRODUCT_MAX_CREDENTIAL_TTL_DAYS + 1,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("BAD_USER_INPUT");
    await app.close();
  });
});

describe("with a tighter maximum declared", () => {
  const declared = { OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS: "30" };

  test("binds the long-lived mount, which never had a bound before", async () => {
    const { app } = harness(declared);
    const refused = await createOverRest(app, { expiresInDays: 90 });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message)
      .toBe("A credential may live at most 30 days on this deployment.");
    await app.close();
  });

  test("binds the canonical Operation at the deployment's number, not the product's", async () => {
    // 90 is inside the contract's 366 and outside this host's 30, so the
    // refusal has to come from the service and name 30.
    const { app } = harness(declared);
    const refused = await createOverOperation(app, { expiresInDays: 90 });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain("at most 30 days on this deployment");
    await app.close();
  });

  test("withdraws the non-expiring credential from the mount that offered it", async () => {
    const { app } = harness(declared);
    const refused = await createOverRest(app, { expiresInDays: null });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message)
      .toMatch(/requires every credential to expire within 30 days/);
    await app.close();
  });

  test("applies the narrowed default to a mint that names no lifetime", async () => {
    const { app } = harness(declared);
    const created = await createOverRest(app, {});
    expect(created.statusCode).toBe(201);
    const lifetimeMs = new Date(created.json().expiresAt as string).getTime() - Date.now();
    expect(lifetimeMs).toBeLessThanOrEqual(30 * DAY_MS);
    expect(lifetimeMs).toBeGreaterThan(29 * DAY_MS);
    await app.close();
  });

  test("leaves nothing behind when it refuses", async () => {
    // The lifetime is resolved before the intent row and before the realm,
    // so a refusal costs neither a row nor a Keycloak client.
    const { app, store: written } = harness(declared);
    expect((await createOverRest(app, { expiresInDays: 400 })).statusCode).toBe(400);
    expect(written.integrations).toEqual([]);
    expect(written.keys).toEqual([]);
    expect(realm.requests).toEqual([]);
    await app.close();
  });

  test("a new workflow application gets no wider rule than anyone else", async () => {
    // Nothing about this integration's name or purpose reaches the policy —
    // it is the one rule, applied to the one kind of row.
    const { app } = harness(declared);
    for (const displayName of ["Workflow application", "Partner portal", "Reporting job"]) {
      const refused = await createOverRest(app, { displayName, expiresInDays: 365 });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toContain("at most 30 days");
    }
    await app.close();
  });
});

describe("with a declared value this build will not interpret", () => {
  test("provisioning is disabled rather than resolved permissively", async () => {
    // A maximum above the product bound is an attempt to widen through
    // configuration. The surface refuses to serve rather than fall back to
    // the broadest rule available.
    for (const value of [String(PRODUCT_MAX_CREDENTIAL_TTL_DAYS + 1), "0", "forever"]) {
      expect(readApiKeyProvisioningConfig({
        ...PROVISIONING_ENV(),
        OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS: value,
      })).toBeUndefined();
    }
  });
});
