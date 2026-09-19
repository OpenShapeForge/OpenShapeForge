// SPDX-License-Identifier: BUSL-1.1
/**
 * The connector OAuth authorize route resolves its session WITH the database:
 * an organization-only token needs the registry, and a person's admission
 * needs the identity link. Proven by handing the route a database whose every
 * access fails — a route that resolved without it would answer from the token
 * alone; one that resolves with it answers 503 from the resolver.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import Fastify from "fastify";
import { __resetSessionResolverForTests } from "../../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { registerConnectorOAuthRoutes } from "../oauth-routes.js";

const ENV_KEYS = [
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  "OPENSHAPEFORGE_ORGANIZATION_CONTEXT",
];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: "jwk" });
let jwks: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  jwks = Bun.serve({
    port: 0,
    fetch: () => Response.json({ keys: [{ ...jwk, kid: "oauth-routes-test", alg: "RS256", use: "sig" }] }),
  });
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = jwks.url.href;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
  delete process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT;
  __resetSessionResolverForTests();
});

afterAll(() => {
  jwks.stop(true);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  __resetSessionResolverForTests();
});

function mint(): string {
  const issued = Math.floor(Date.now() / 1000);
  const payload = {
    tid: "11111111-1111-4111-8111-111111111111",
    azp: "web",
    email: "person@example.com",
    iss: "https://issuer.example.test",
    aud: "api",
    sub: "22222222-2222-4222-8222-222222222222",
    iat: issued,
    exp: issued + 120,
  };
  const body = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "oauth-routes-test" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
  ].join(".");
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), pair.privateKey).toString("base64url")}`;
}

test("the authorize route resolves the session with the route's database", async () => {
  let accessed = 0;
  const db = new Proxy({}, {
    get() {
      accessed++;
      throw new Error("statement timeout");
    },
  }) as OpenShapeForgeDatabase;
  const app = Fastify();
  registerConnectorOAuthRoutes(app, {
    db,
    config: { keyring: undefined } as never,
    publicOrigin: "https://api.example.test",
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/rest/v1/connectors/example/installations/main/authorize",
    headers: { authorization: `Bearer ${mint()}` },
  });
  expect(accessed).toBeGreaterThan(0);
  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body).error.code).toBe("AUTHENTICATION_UNAVAILABLE");
  await app.close();
});
