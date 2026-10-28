// SPDX-License-Identifier: BUSL-1.1
/**
 * What actually travels back on the wire when a credential is handed over.
 *
 * The assertions here are on a real Fastify response — status line, headers,
 * body — rather than on what a handler returned, because `no-store` is only
 * worth anything if it reaches the socket. A secret that is returned exactly
 * once and is not retrievable afterwards must not be the sort of thing a
 * shared cache, a proxy or a browser's back button keeps the only copy of.
 *
 * Both surfaces are exercised: the pre-existing `/api/api-keys` mount and the
 * canonical Operation's REST projection, which carries the headers its handler
 * declares. The realm half runs against a stub Keycloak Admin API over real
 * HTTP, so the provisioning client is the shipped one.
 */
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { __resetSessionResolverForTests } from "../identity.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { registerOperationRestRoutes, listOperationContracts } from "../../operations/runtime.js";
import { fixtureDatabase, fixtureStore, stubRealm, type FixtureStore, type StubRealm } from "./__tests__/fixtures.js";
import { credentialsReachNoCache } from "./graphql-schema.js";
import { registerApiKeyRestRoutes, API_KEY_MOUNT } from "./rest-routes.js";
import { readApiKeyProvisioningConfig, type ApiKeyProvisioningConfig } from "./runtime-config.js";

const SECRET = "api-key-response-test-context-secret";
const TENANT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "33333333-3333-4333-8333-333333333333";
const MANAGE_ROLE = "Platform.ApiKeys.Manage";
const READ_ROLE = "Relations.All.Read";
const INTEGRATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

/** The headers a one-time credential response must carry, exactly. */
const EXPECTED_NO_STORE = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache" };

/**
 * The hop apps/web signs for a logged-in administrator: the identity, and the
 * principal class the web tier established from that person's own login. The
 * class is inside the HMAC, so these headers are the only way this suite can
 * reach a minting path at all — see `carrier-admission.test.ts` for what a
 * caller gets by writing the same header itself.
 */
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
let logged: string[];

function harness(store: FixtureStore): { app: FastifyInstance; db: OpenShapeForgeDatabase; config: ApiKeyProvisioningConfig } {
  const { db } = fixtureDatabase(store);
  const config = readApiKeyProvisioningConfig({
    OPENSHAPEFORGE_API_KEY_SECRET_KEYS: `test:${Buffer.alloc(32, 7).toString("base64")}`,
    OPENSHAPEFORGE_KEYCLOAK_BASE_URL: realm.baseUrl,
    OPENSHAPEFORGE_KEYCLOAK_REALM: realm.realm,
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID: "provisioner",
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET: "provisioner-secret",
  })!;
  // Every log line is captured so the body can be compared against it: a
  // secret in a request log is a disclosure that outlives the response.
  const app = Fastify({
    logger: { level: "trace", stream: { write(line: string) { logged.push(line); } } },
  });
  return { app, db: db as unknown as OpenShapeForgeDatabase, config };
}

beforeEach(() => {
  logged = [];
  realm = stubRealm({ roles: [READ_ROLE] });
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = SECRET;
  // The resolver names the issuer behind a trusted-context bundle from this
  // variable; without it no identity can be resolved and every request is
  // refused as unavailable rather than answered.
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://identity.test/realms/openshapeforge";
  __resetSessionResolverForTests();
});

afterEach(async () => {
  delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  __resetSessionResolverForTests();
  await realm.stop();
});

describe("one-time credential responses", () => {
  test("the existing REST mount returns the secret uncacheable, and never logs it", async () => {
    const store = fixtureStore();
    const { app, db, config } = harness(store);
    registerApiKeyRestRoutes(app, { db, config });

    const created = await app.inject({
      method: "POST",
      url: API_KEY_MOUNT,
      headers: managerHeaders(),
      payload: JSON.stringify({ displayName: "Partner portal", roles: [READ_ROLE], expiresInDays: 30 }),
    });
    expect({ status: created.statusCode, body: created.body }).toMatchObject({ status: 201 });
    const token = created.json().token as string;
    expect(typeof token).toBe("string");
    expect(created.headers["cache-control"]).toBe(EXPECTED_NO_STORE["cache-control"]);
    expect(created.headers.pragma).toBe(EXPECTED_NO_STORE.pragma);

    const issued = await app.inject({
      method: "POST",
      url: `${API_KEY_MOUNT}/${store.integrations[0]!.id}/keys`,
      headers: managerHeaders(),
      payload: JSON.stringify({ displayName: "Rotation", expiresInDays: 30 }),
    });
    expect({ status: issued.statusCode, body: issued.body }).toMatchObject({ status: 201 });
    const rotated = issued.json().token as string;
    expect(rotated).not.toBe(token);
    expect(issued.headers["cache-control"]).toBe(EXPECTED_NO_STORE["cache-control"]);
    expect(issued.headers.pragma).toBe(EXPECTED_NO_STORE.pragma);

    // Neither secret reached the log, and neither reached the realm.
    const transcript = logged.join("\n");
    for (const secret of [token, rotated]) {
      expect(transcript).not.toContain(secret);
      expect(JSON.stringify(realm.requests)).not.toContain(secret);
    }
    await app.close();
  });

  test("the metadata listing on the same mount is left cacheable by default", async () => {
    // The header is targeted at the two responses that carry a credential, not
    // sprayed across the mount; a metadata read has nothing to withhold.
    const { app, db, config } = harness(fixtureStore());
    registerApiKeyRestRoutes(app, { db, config });
    const listed = await app.inject({ method: "GET", url: API_KEY_MOUNT, headers: managerHeaders() });
    expect({ status: listed.statusCode, body: listed.body }).toMatchObject({ status: 200 });
    expect(listed.headers["cache-control"]).toBeUndefined();
    await app.close();
  });

  test("the GraphQL mint marks its reply when one is reachable, and is inert when not", () => {
    // GraphQL has no per-field response metadata, so the two minting mutations
    // reach the reply Yoga merges into the resolver context. Asserted both
    // ways: an embedding without a reply must be a no-op rather than a crash,
    // and one with a reply must actually set the headers.
    const set = new Map<string, string>();
    const withReply = {
      session: {},
      fastifyReply: { header: (name: string, value: string) => set.set(name, value) },
    } as unknown as Parameters<typeof credentialsReachNoCache>[0];
    expect(credentialsReachNoCache(withReply)).toBe(true);
    expect(Object.fromEntries(set)).toEqual(EXPECTED_NO_STORE);

    const withoutReply = { session: {} } as unknown as Parameters<typeof credentialsReachNoCache>[0];
    expect(credentialsReachNoCache(withoutReply)).toBe(false);
    expect(credentialsReachNoCache({ session: {}, fastifyReply: {} } as never)).toBe(false);
  });

  test("the canonical Operation's REST projection carries the same headers", async () => {
    const store = fixtureStore([{
      id: INTEGRATION, tenantId: TENANT, displayName: "Payroll sync", status: "active",
      grantedRoles: [READ_ROLE], createdAt: new Date("2026-01-02T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    }]);
    const { app, db, config } = harness(store);
    // The Operation handler reads its provisioning configuration from the
    // environment, so the stub realm has to be there too.
    process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS = `test:${Buffer.alloc(32, 7).toString("base64")}`;
    process.env.OPENSHAPEFORGE_KEYCLOAK_BASE_URL = realm.baseUrl;
    process.env.OPENSHAPEFORGE_KEYCLOAK_REALM = realm.realm;
    process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID = "provisioner";
    process.env.OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET = "provisioner-secret";
    try {
      const apiKeyOperations = listOperationContracts()
        .filter((operation) => operation.plugin === "osf-api-keys");
      registerOperationRestRoutes(app, [], { db }, apiKeyOperations);

      // Minting takes an explicit acknowledgement; without it the Operation is
      // refused with the retry instruction and nothing is issued.
      const unconfirmed = await app.inject({
        method: "POST",
        url: "/api/api-key-integrations/issue-credential",
        headers: managerHeaders(),
        payload: JSON.stringify({ integrationId: INTEGRATION, displayName: "Rotation", expiresInDays: 30 }),
      });
      expect(unconfirmed.statusCode).toBe(428);
      expect(unconfirmed.json().error.code).toBe("CONFIRMATION_REQUIRED");
      expect(unconfirmed.body).not.toContain("osf_");

      const issued = await app.inject({
        method: "POST",
        url: "/api/api-key-integrations/issue-credential",
        headers: managerHeaders(),
        payload: JSON.stringify({
          integrationId: INTEGRATION, displayName: "Rotation", expiresInDays: 30, confirmed: true,
        }),
      });
      expect({ status: issued.statusCode, body: issued.body }).toMatchObject({ status: 200 });
      const secret = issued.json().credential.secret as string;
      expect(typeof secret).toBe("string");
      expect(issued.headers["cache-control"]).toBe(EXPECTED_NO_STORE["cache-control"]);
      expect(issued.headers.pragma).toBe(EXPECTED_NO_STORE.pragma);

      // The metadata read on the same projection is not marked.
      const read = await app.inject({
        method: "POST",
        url: "/api/api-key-integrations/get",
        headers: managerHeaders(),
        payload: JSON.stringify({ integrationId: INTEGRATION }),
      });
      expect({ status: read.statusCode, body: read.body }).toMatchObject({ status: 200 });
      expect(read.json()).not.toHaveProperty("secret");
      expect(read.headers["cache-control"]).toBeUndefined();

      expect(logged.join("\n")).not.toContain(secret);
      expect(config.entityRoleClientId).toBe("erp-provider");
    } finally {
      for (const name of [
        "OPENSHAPEFORGE_API_KEY_SECRET_KEYS",
        "OPENSHAPEFORGE_KEYCLOAK_BASE_URL",
        "OPENSHAPEFORGE_KEYCLOAK_REALM",
        "OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID",
        "OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET",
      ]) delete process.env[name];
      await app.close();
    }
  });
});
