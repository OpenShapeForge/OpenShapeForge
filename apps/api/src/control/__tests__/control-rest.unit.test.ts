// SPDX-License-Identifier: BUSL-1.1
/**
 * The control Operations on REST, through the canonical operation routes:
 * a control-realm bearer signed by a throwaway key served as a JWKS, one
 * round trip per web page group, and the refusals that must not disclose
 * which realm the surface trusts.
 *
 * The database answers every query with no rows, so a list is empty, a
 * lookup is NOT_FOUND, and nothing needs Postgres; the control-plane
 * services still run — elevation, audit insert and all — against it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { registerOperationRestRoutes } from "../../operations/runtime.js";
import { __resetControlVerifiersForTests, PLATFORM_OPERATOR_ROLE } from "../authorization.js";
import type { ControlPlaneConfig } from "../config.js";
import { PLATFORM_ADMIN_ROLE } from "../platform-admin.js";
import { PLATFORM_GUIDE } from "../platform-tools.js";
import { createControlRuntime } from "../runtime.js";
import { controlOperationContracts } from "./control-operation-fixtures.js";

const CONTROL_ISSUER = "https://keycloak.test/realms/openshapeforge-control";
const TENANT_ISSUER = "https://keycloak.test/realms/openshapeforge";
const GATEWAY = "openshapeforge-admin-gateway";

let jwks: ReturnType<typeof Bun.serve>;
let controlKey: KeyObject;
let tenantKey: KeyObject;
let config: ControlPlaneConfig;
let app: FastifyInstance;
let unconfigured: FastifyInstance;

function signJwt(key: KeyObject, payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", kid: "test", typ: "JWT" })}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function mint(key: KeyObject, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(key, { iat: now, exp: now + 300, ...claims });
}

const token = (roles: string[], overrides: Record<string, unknown> = {}) =>
  mint(controlKey, {
    iss: CONTROL_ISSUER,
    sub: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
    azp: GATEWAY,
    preferred_username: "platform-operator",
    realm_access: { roles },
    ...overrides,
  });

function emptyDatabase() {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** `roles/api.ts` hands routes an unparsed buffer; mirror it so the route's own parsing runs. */
function controlApp(runtime: ReturnType<typeof createControlRuntime>): FastifyInstance {
  const instance = Fastify();
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  registerOperationRestRoutes(
    instance,
    [],
    { db: emptyDatabase(), control: runtime },
    controlOperationContracts(),
    { pluginOperations: "absent" },
  );
  return instance;
}

beforeAll(async () => {
  const control = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tenant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  controlKey = control.privateKey;
  tenantKey = tenant.privateKey;
  const jwk = { ...control.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  config = {
    keycloak: { baseUrl: "https://keycloak.test", tenantRealm: "openshapeforge", clientId: "openshapeforge-auth-api", clientSecret: "test-secret" },
    operator: { issuer: CONTROL_ISSUER, jwksUri: new URL("/certs", jwks.url).href, clientId: GATEWAY },
    mcpResource: { origins: ["http://127.0.0.1:3001"], clients: ["codex"] },
    platformMcp: { authorizedParties: ["codex-platform"] },
  };
  __resetControlVerifiersForTests();
  app = controlApp(createControlRuntime({ config: { ok: true, config }, operations: controlOperationContracts() }));
  unconfigured = controlApp(createControlRuntime({
    config: { ok: false, missing: ["OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER"] },
    operations: controlOperationContracts(),
  }));
  await app.ready();
  await unconfigured.ready();
});

afterAll(async () => {
  await app?.close();
  await unconfigured?.close();
  jwks?.stop(true);
  __resetControlVerifiersForTests();
});

async function call(method: "GET" | "POST" | "PATCH" | "PUT", url: string, bearer?: string, payload?: unknown, instance = app) {
  const response = await instance.inject({
    method,
    url,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

describe("one round trip per page group", () => {
  test("platform: the guide and whoami, for either role", async () => {
    const guide = await call("GET", "/api/control/v1/guide", token([PLATFORM_OPERATOR_ROLE]));
    expect(guide.status).toBe(200);
    expect(guide.body).toEqual({ guide: PLATFORM_GUIDE });
    const who = await call("GET", "/api/control/v1/whoami", token([PLATFORM_ADMIN_ROLE]));
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ role: "Platform administrator", scope: "platform", tenants: 0, access: { tools: 24, resources: 1 } });
    expect(who.body.signedInVia).toBe("Hubble control plane");
    const operator = await call("GET", "/api/control/v1/whoami", token([PLATFORM_OPERATOR_ROLE]));
    expect(operator.body.role).toBe("Platform operator");
  });

  test("tenants: the registry read under the Operation's own output shape", async () => {
    const tenants = await call("GET", "/api/control/v1/tenants", token([PLATFORM_OPERATOR_ROLE]));
    expect(tenants.status).toBe(200);
    expect(tenants.body).toEqual({ tenants: [] });
    // A write needs the acknowledgement before the handler is reached at all...
    const unconfirmed = await call("PATCH", "/api/control/v1/tenants/acme", token([PLATFORM_OPERATOR_ROLE]), { status: "suspended" });
    expect(unconfirmed.status).toBe(428);
    expect(unconfirmed.body.error.code).toBe("CONFIRMATION_REQUIRED");
    // ...and, confirmed, answers in the declared vocabulary with the service's code kept.
    const confirmed = await call("PATCH", "/api/control/v1/tenants/acme", token([PLATFORM_OPERATOR_ROLE]), { status: "suspended", confirmed: true });
    expect(confirmed.status).toBe(404);
    expect(confirmed.body.error).toMatchObject({ code: "NOT_FOUND", detail: "CONTROL_TENANT_NOT_FOUND" });
    // A path parameter travels only in the URL.
    const duplicated = await call("PATCH", "/api/control/v1/tenants/acme", token([PLATFORM_OPERATOR_ROLE]), { slug: "acme", status: "suspended", confirmed: true });
    expect(duplicated.status).toBe(400);
  });

  test("organizations: the tree of a tenant that does not exist is NOT_FOUND, never a Keycloak call", async () => {
    const tree = await call("GET", "/api/control/v1/tenants/acme/organizations", token([PLATFORM_OPERATOR_ROLE]));
    expect(tree.status).toBe(404);
    expect(tree.body.error).toMatchObject({ code: "NOT_FOUND", detail: "CONTROL_TENANT_NOT_FOUND", message: 'No tenant with slug "acme".' });
    const badSlug = await call("GET", "/api/control/v1/tenants/Not%20Valid/organizations", token([PLATFORM_OPERATOR_ROLE]));
    expect(badSlug.status).toBe(400);
  });

  test("services: the catalog is platform_admin's, and without a provider says so as a conflict", async () => {
    const forbidden = await call("GET", "/api/control/v1/catalog", token([PLATFORM_OPERATOR_ROLE]));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    const unavailable = await call("GET", "/api/control/v1/catalog", token([PLATFORM_ADMIN_ROLE]));
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error).toMatchObject({ code: "CONFLICT", detail: "PLATFORM_CATALOG_UNAVAILABLE" });
    const both = await call("GET", "/api/control/v1/catalog/service/record-finding", token([PLATFORM_ADMIN_ROLE, PLATFORM_OPERATOR_ROLE]));
    expect(both.status).toBe(409);
  });

  test("notices: listed and withdrawn under the Operation's own shapes", async () => {
    const notices = await call("GET", "/api/control/v1/notices", token([PLATFORM_ADMIN_ROLE]));
    expect(notices.status).toBe(200);
    expect(notices.body).toEqual({ notices: [] });
    const withdrawn = await call("POST", "/api/control/v1/notices/day-start-v3/withdraw", token([PLATFORM_ADMIN_ROLE]));
    expect(withdrawn.status).toBe(404);
    expect(withdrawn.body.error).toMatchObject({ code: "NOT_FOUND", detail: "UPDATE_NOTICE_NOT_FOUND" });
  });
});

describe("who is refused, and how", () => {
  test("no token, a tenant-realm token, admin-cli and a member without a platform role", async () => {
    const anonymous = await call("GET", "/api/control/v1/tenants");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("UNAUTHENTICATED");
    const tenantToken = mint(tenantKey, {
      iss: TENANT_ISSUER, sub: "user-a", azp: "codex", aud: ["erp-provider"],
      realm_access: { roles: [PLATFORM_ADMIN_ROLE] },
    });
    const foreign = await call("GET", "/api/control/v1/tenants", tenantToken);
    expect(foreign.status).toBe(401);
    expect(foreign.body.error.code).toBe("UNAUTHENTICATED");
    for (const message of [foreign.body.error.message, anonymous.body.error.message] as string[]) {
      expect(message).not.toContain("openshapeforge");
      expect(message).not.toContain("issuer");
    }
    expect((await call("GET", "/api/control/v1/tenants", token([PLATFORM_ADMIN_ROLE], { azp: "admin-cli" }))).status).toBe(401);
    const noRole = await call("GET", "/api/control/v1/tenants", token(["default-roles-openshapeforge-control"]));
    expect(noRole.status).toBe(403);
    expect(noRole.body.error.code).toBe("FORBIDDEN");
  });

  test("an unconfigured control plane answers 503 naming what is missing, before any token is read", async () => {
    const response = await call("GET", "/api/control/v1/tenants", token([PLATFORM_ADMIN_ROLE]), undefined, unconfigured);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("CONTROL_PLANE_NOT_CONFIGURED");
    expect(response.body.error.message).toContain("OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER");
  });
});
