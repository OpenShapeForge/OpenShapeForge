// SPDX-License-Identifier: BUSL-1.1
/**
 * Who actually reaches the credential-management surface, over a real hop.
 *
 * The ceiling's carrier rule is unit-tested on a session object
 * (`ceiling.test.ts`); this suite proves the thing in front of it — that a
 * session carrying a person verdict can only be PRODUCED by a party that
 * established one. Everything here goes through the shipped resolver
 * (`auth/identity.ts`) and the shipped REST mount, from headers in:
 *
 *   - the real in-mesh hop apps/web signs for a logged-in administrator,
 *     with the principal class inside the HMAC;
 *   - the same hop from a producer that authenticated nobody — a health
 *     probe, a fixture, a service-to-service call — which signs no class;
 *   - a forged class, written onto a bundle this deployment really signed;
 *   - a verified Keycloak SERVICE token, through the shipped bearer verifier
 *     against a local JWKS, holding the management role.
 *
 * The last one carries the second claim: refusing it at this surface must
 * not break it anywhere else. The same token still resolves to the session
 * an organization's existing automation runs on, with its tenant and its
 * roles — the refusal is this mount's, not the credential's.
 */
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { __resetSessionResolverForTests, resolveSessionContext } from "../identity.js";
import { assertMayManageApiKeys } from "./ceiling.js";
import { fixtureDatabase, fixtureStore, stubRealm, type StubRealm } from "./__tests__/fixtures.js";
import { API_KEY_MOUNT, registerApiKeyRestRoutes } from "./rest-routes.js";
import { readApiKeyProvisioningConfig } from "./runtime-config.js";

const SECRET = "carrier-admission-context-secret";
const ISSUER = "https://identity.test/realms/openshapeforge";
const AUDIENCE = "erp-provider";
const TENANT = "11111111-1111-4111-8111-111111111111";
const PERSON = "33333333-3333-4333-8333-333333333333";
const SERVICE_SUBJECT = "44444444-4444-4444-8444-444444444444";
const MANAGE_ROLE = "Platform.ApiKeys.Manage";
const READ_ROLE = "Relations.All.Read";

const PERSON_ONLY = /Only a verified person may manage API keys/;

/** A trusted-context bundle, signed exactly as a producer would sign it. */
function hop(principalKind?: "person" | "service"): Record<string, string> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, {
    tenantId: TENANT,
    userId: PERSON,
    roles: [MANAGE_ROLE, READ_ROLE],
    ...(principalKind ? { principalKind } : {}),
  }, { secret: SECRET });
  return Object.fromEntries(headers.entries());
}

let realm: StubRealm;
let app: FastifyInstance;
let db: OpenShapeForgeDatabase;
let jwks: ReturnType<typeof Bun.serve>;
let signingKey: KeyObject;

/**
 * A Keycloak service-account token the shipped verifier really accepts:
 * RS256 over a local JWKS, `azp` naming the client and the
 * `service-account-<azp>` username Keycloak gives a client-credentials
 * principal. Nothing about it is asserted by the caller — the session's
 * verdict is derived from these verified claims.
 */
function serviceToken(roles: string[]): string {
  const issued = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    azp: AUDIENCE,
    sub: SERVICE_SUBJECT,
    tid: TENANT,
    preferred_username: `service-account-${AUDIENCE}`,
    resource_access: { [AUDIENCE]: { roles } },
    iat: issued,
    exp: issued + 120,
  };
  const body = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "carrier-test" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
  ].join(".");
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), signingKey).toString("base64url")}`;
}

beforeEach(() => {
  realm = stubRealm({ roles: [READ_ROLE] });
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  signingKey = pair.privateKey;
  const jwk = pair.publicKey.export({ format: "jwk" });
  jwks = Bun.serve({
    port: 0,
    fetch: () => Response.json({ keys: [{ ...jwk, kid: "carrier-test", alg: "RS256", use: "sig" }] }),
  });
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = SECRET;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = ISSUER;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = jwks.url.href;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = AUDIENCE;
  __resetSessionResolverForTests();

  db = fixtureDatabase(fixtureStore()).db as unknown as OpenShapeForgeDatabase;
  const config = readApiKeyProvisioningConfig({
    OPENSHAPEFORGE_API_KEY_SECRET_KEYS: `test:${Buffer.alloc(32, 9).toString("base64")}`,
    OPENSHAPEFORGE_KEYCLOAK_BASE_URL: realm.baseUrl,
    OPENSHAPEFORGE_KEYCLOAK_REALM: realm.realm,
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_ID: "provisioner",
    OPENSHAPEFORGE_KEYCLOAK_ADMIN_CLIENT_SECRET: "provisioner-secret",
  })!;
  app = Fastify();
  registerApiKeyRestRoutes(app, { db, config });
});

afterEach(async () => {
  for (const name of [
    "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET",
    "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
    "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
    "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  ]) delete process.env[name];
  __resetSessionResolverForTests();
  jwks.stop(true);
  await realm.stop();
  await app.close();
});

describe("who reaches credential management over a real hop", () => {
  test("admits the in-mesh hop apps/web signs for a logged-in person", async () => {
    const listed = await app.inject({ method: "GET", url: API_KEY_MOUNT, headers: hop("person") });
    expect({ status: listed.statusCode, body: listed.body }).toMatchObject({ status: 200 });
  });

  test("refuses the same hop from a producer that authenticated nobody", async () => {
    // The health probe and every internal service call sign a bundle without
    // a class. Before the class travelled in the payload these were admitted
    // on the carrier alone, which is the hole this closes.
    for (const headers of [hop(), hop("service")]) {
      const listed = await app.inject({ method: "GET", url: API_KEY_MOUNT, headers });
      expect(listed.statusCode).toBe(403);
      expect(listed.json().error.message).toMatch(PERSON_ONLY);
    }
  });

  test("refuses a class a caller appended to a genuinely signed bundle", async () => {
    // The signature covers the class, so adding the header invalidates the
    // whole bundle rather than upgrading it: the identity is dropped and the
    // request is not authenticated at all.
    const forged = { ...hop(), "x-user-principal-kind": "person" };
    const listed = await app.inject({ method: "GET", url: API_KEY_MOUNT, headers: forged });
    expect(listed.statusCode).toBe(403);
    expect(listed.json().error.message).toMatch(/Authentication is required/);
  });

  test("refuses a bundle that names a person under the wrong secret", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(headers, {
      tenantId: TENANT, userId: PERSON, roles: [MANAGE_ROLE], principalKind: "person",
    }, { secret: "not-this-deployments-secret" });
    const listed = await app.inject({
      method: "GET", url: API_KEY_MOUNT, headers: Object.fromEntries(headers.entries()),
    });
    expect(listed.statusCode).toBe(403);
    expect(listed.json().error.message).toMatch(/Authentication is required/);
  });

  test("refuses a verified service token holding the management role", async () => {
    const listed = await app.inject({
      method: "GET",
      url: API_KEY_MOUNT,
      headers: { authorization: `Bearer ${serviceToken([MANAGE_ROLE, READ_ROLE])}` },
    });
    expect(listed.statusCode).toBe(403);
    expect(listed.json().error.message).toMatch(PERSON_ONLY);
  });

  test("leaves an organization's existing automation working on that same token", async () => {
    // The refusal above belongs to the key-management surface, not to the
    // credential: the token still resolves to the session the automation
    // runs on, with its tenant and the roles its ordinary work needs.
    const token = serviceToken([READ_ROLE]);
    const session = await resolveSessionContext(
      new Headers({ authorization: `Bearer ${token}` }),
      { db },
    );
    expect(session).toMatchObject({
      tenantId: TENANT,
      userId: SERVICE_SUBJECT,
      credential: "bearer",
      principalKind: "service",
    });
    expect(session.roles).toContain(READ_ROLE);
    // And it is refused here, and only here, for being what it is.
    expect(() => assertMayManageApiKeys(session)).toThrow(PERSON_ONLY);
  });
});
