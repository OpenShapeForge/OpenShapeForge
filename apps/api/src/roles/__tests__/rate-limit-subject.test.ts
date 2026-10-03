// SPDX-License-Identifier: BUSL-1.1
/**
 * #886: every person behind one proxy address, and the workflow worker, used
 * to share the anonymous per-IP bucket. A locally verified bearer token is now
 * counted per subject (service identities on their own budget), the event
 * stream has its own bucket, and anything unverifiable stays per IP.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Registry } from "@openshapeforge/observability";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { __resetBearerVerifiersForTests } from "../../auth/bearer-verifier.js";
import { createApiApp } from "../api.js";
import { isEventStream, limitKey, limitPolicyFromEnv, tierOfKey, VERIFY_BUDGET_MS, type LimitSubjectVerifier } from "../rate-limit-subject.js";
import { readApiLimits } from "../../config/limits.js";

const ISSUER = "https://identity.example.test/realms/test";
const GRAPHQL_URL = "/api/graphql?query=%7B__typename%7D";
const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
let app: FastifyInstance | undefined;
let jwks: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  await app?.close(); app = undefined;
  jwks?.stop(true); jwks = undefined;
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  __resetBearerVerifiersForTests();
});

const request = (url: string, authorization?: string) =>
  ({ url, ip: "127.0.0.1", headers: authorization ? { authorization } : {} }) as unknown as FastifyRequest;

const SERVICE_ENV = { OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES: JSON.stringify([{ tenantId: "11111111-1111-4111-8111-111111111111", clientId: "org-worker", clientSecret: "x" }]) };
const policyFor = (verify: LimitSubjectVerifier | null, env: NodeJS.ProcessEnv = SERVICE_ENV) => limitPolicyFromEnv(() => verify, env);

describe("limit keys", () => {
  const verify = async (token: string) => {
    if (token === "forged") throw new Error("signature");
    return { claims: JSON.parse(token) as Record<string, unknown> };
  };
  const bearer = (claims: Record<string, unknown>) => `Bearer ${JSON.stringify(claims)}`;
  const policy = policyFor(verify);

  test("a verified person, a service identity, and an unverifiable token", async () => {
    const person = await limitKey(request("/api/graphql", bearer({ iss: ISSUER, sub: "p1", azp: "web" })), undefined, policy);
    expect(person).toBe(`sub:${ISSUER}:p1`);
    expect(tierOfKey(person)).toBe("subject");
    const worker = await limitKey(request("/api/operations/X", bearer({ iss: ISSUER, sub: "s1", azp: "org-worker", preferred_username: "service-account-org-worker" })), undefined, policy);
    expect(worker).toBe(`sa:${ISSUER}:org-worker`);
    expect(tierOfKey(worker)).toBe("service");
    const forged = await limitKey(request("/api/graphql", "Bearer forged"), undefined, policy);
    expect(forged).toBe("ip:127.0.0.1");
    expect(tierOfKey(forged)).toBe("anonymous");
    expect(await limitKey(request("/api/graphql", bearer({ iss: ISSUER, sub: "p1" })), undefined, policyFor(null))).toBe("ip:127.0.0.1");
    expect(await limitKey(request("/api/graphql", bearer({ sub: "p1" })), undefined, policy)).toBe("ip:127.0.0.1");
  });

  test("the service tier is only for a configured organization service identity", async () => {
    const stranger = bearer({ iss: ISSUER, sub: "s2", azp: "other-client", preferred_username: "service-account-other-client" });
    expect(await limitKey(request("/api/graphql", stranger), undefined, policy)).toBe(`sub:${ISSUER}:s2`);
    const unconfigured = await limitKey(request("/api/graphql", bearer({ iss: ISSUER, sub: "s1", azp: "org-worker", preferred_username: "service-account-org-worker" })), undefined, policyFor(verify, {}));
    expect(tierOfKey(unconfigured)).toBe("subject");
  });

  test("a token for another audience earns no bucket of its own", async () => {
    const pinned = policyFor(verify, { ...SERVICE_ENV, OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE: "example-api", OPENSHAPEFORGE_PUBLIC_ORIGIN: "https://example.example" });
    expect(await limitKey(request("/api/graphql", bearer({ iss: ISSUER, sub: "p1", aud: "example-api" })), undefined, pinned)).toBe(`sub:${ISSUER}:p1`);
    expect(await limitKey(request("/api/graphql", bearer({ iss: ISSUER, sub: "p1", aud: ["account", "https://example.example/acme"] })), undefined, pinned)).toBe(`sub:${ISSUER}:p1`);
    expect(await limitKey(request("/api/graphql", bearer({ iss: ISSUER, sub: "p1", aud: "sibling-client" })), undefined, pinned)).toBe("ip:127.0.0.1");
    expect(await limitKey(request("/api/graphql", bearer({ iss: ISSUER, sub: "p1", aud: "https://example.example.evil/x" })), undefined, pinned)).toBe("ip:127.0.0.1");
  });

  test("verification that takes longer than the budget falls back to the IP", async () => {
    const slow: LimitSubjectVerifier = () => new Promise(resolve => setTimeout(() => resolve({ claims: { iss: ISSUER, sub: "p1" } }), VERIFY_BUDGET_MS + 200));
    const started = Date.now();
    expect(await limitKey(request("/api/graphql", bearer({})), undefined, policyFor(slow))).toBe("ip:127.0.0.1");
    expect(Date.now() - started).toBeLessThan(VERIFY_BUDGET_MS + 150);
  });

  test("the event stream has its own bucket with the same tier", async () => {
    expect(isEventStream("/api/events")).toBe(true);
    expect(isEventStream("/acme/api/events?x=1")).toBe(true);
    expect(isEventStream("/api/eventsx")).toBe(false);
    expect(isEventStream("/a/b/api/events")).toBe(false);
    expect(isEventStream("/api/rest/v1/notes/api/events")).toBe(false);
    const key = await limitKey(request("/api/events", bearer({ iss: ISSUER, sub: "p1" })), undefined, policy);
    expect(key).toBe(`events:sub:${ISSUER}:p1`);
    expect(tierOfKey(key)).toBe("subject");
    expect(tierOfKey("events:ip:127.0.0.1")).toBe("anonymous");
  });

  test("budgets: subject defaults to anonymous, service to trusted, both configurable", () => {
    expect(readApiLimits({ API_RATE_LIMIT_MAX: "10" }).rateLimitTiers).toEqual({ anonymous: 10, trusted: 50, subject: 10, service: 50 });
    expect(readApiLimits({ API_RATE_LIMIT_MAX_SUBJECT: "7", API_RATE_LIMIT_MAX_SERVICE: "9" }).rateLimitTiers)
      .toMatchObject({ subject: 7, service: 9 });
  });
});

describe("the API boundary", () => {
  let signingKey: CryptoKey | undefined;
  async function signer() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    signingKey = privateKey as CryptoKey;
    const key = { ...await exportJWK(publicKey), kid: "limit-test", alg: "RS256" };
    jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [key] }) });
    setEnv("OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI", new URL("/jwks", jwks.url).href);
    setEnv("OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER", ISSUER);
    setEnv("OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE", "api");
    __resetBearerVerifiersForTests();
    return async (subject: string, extra: Record<string, unknown> = {}) => `Bearer ${await new SignJWT({ azp: "web", ...extra })
      .setProtectedHeader({ alg: "RS256", kid: "limit-test" }).setIssuer(ISSUER).setAudience("api").setSubject(subject)
      .setIssuedAt().setExpirationTime("2m").sign(privateKey)}`;
  }

  test("two people from one address have their own budgets; the anonymous one is unchanged", async () => {
    const sign = await signer();
    setEnv("API_RATE_LIMIT_MAX", "2");
    setEnv("API_RATE_LIMIT_REDIS_URL", undefined);
    app = createApiApp({ cors: false });
    const first = { authorization: await sign("person-1") };
    const second = { authorization: await sign("person-2") };
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: first })).statusCode).not.toBe(429);
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: first })).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: second })).statusCode).not.toBe(429);
    // Anonymous and forged callers still share the per-IP budget.
    const forged = { authorization: `${first.authorization.slice(0, -4)}AAAA` };
    for (let i = 0; i < 2; i++) await app.inject({ method: "GET", url: GRAPHQL_URL, headers: forged });
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL })).statusCode).toBe(429);
    expect(app.rateLimitMetrics.snapshot().throttled).toMatchObject({ subject: 1, anonymous: 1 });
  });

  test("expired and other-issuer tokens stay on the anonymous per-IP budget", async () => {
    const sign = await signer();
    setEnv("API_RATE_LIMIT_MAX", "2");
    setEnv("API_RATE_LIMIT_REDIS_URL", undefined);
    app = createApiApp({ cors: false });
    const { privateKey } = await generateKeyPair("RS256");
    const expired = `Bearer ${await new SignJWT({ azp: "web" }).setProtectedHeader({ alg: "RS256", kid: "limit-test" }).setIssuer(ISSUER)
      .setAudience("api").setSubject("person-x").setIssuedAt(Math.floor(Date.now() / 1000) - 600).setExpirationTime(Math.floor(Date.now() / 1000) - 300).sign(signingKey!)}`;
    const foreign = `Bearer ${await new SignJWT({ azp: "web" }).setProtectedHeader({ alg: "RS256", kid: "limit-test" }).setIssuer("https://evil.example/realms/x")
      .setAudience("api").setSubject("person-y").setIssuedAt().setExpirationTime("2m").sign(signingKey!)}`;
    const unsigned = `Bearer ${await new SignJWT({ azp: "web" }).setProtectedHeader({ alg: "RS256", kid: "limit-test" }).setIssuer(ISSUER)
      .setAudience("api").setSubject("person-z").setIssuedAt().setExpirationTime("2m").sign(privateKey)}`;
    await app.inject({ method: "GET", url: GRAPHQL_URL, headers: { authorization: expired } });
    await app.inject({ method: "GET", url: GRAPHQL_URL, headers: { authorization: foreign } });
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: { authorization: unsigned } })).statusCode).toBe(429);
    // A valid person is unaffected by that shared exhaustion.
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: { authorization: await sign("person-ok") } })).statusCode).not.toBe(429);
  });

  test("the service identity gets the service budget, and a person's stream is not starved by their requests", async () => {
    const sign = await signer();
    setEnv("API_RATE_LIMIT_MAX", "2");
    setEnv("API_RATE_LIMIT_MAX_SERVICE", "5");
    setEnv("OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES", SERVICE_ENV.OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES);
    setEnv("API_RATE_LIMIT_REDIS_URL", undefined);
    app = createApiApp({ cors: false });
    const worker = { authorization: await sign("svc-subject", { azp: "org-worker", preferred_username: "service-account-org-worker" }) };
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: worker })).statusCode).not.toBe(429);
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: worker })).statusCode).toBe(429);

    const person = { authorization: await sign("person-3") };
    for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: GRAPHQL_URL, headers: person });
    const stream = await app.inject({ method: "GET", url: "/api/events", headers: person });
    expect(stream.statusCode).not.toBe(429);
  });
});

// Numeric proxy depth stays an exact trust boundary with the current Fastify API.
describe("forwarded address trust depth", () => {
  for (const [depth, expected] of [["0", "127.0.0.1"], ["1", "10.0.0.2"], ["2", "203.0.113.1"]] as const) {
    test(`trusts exactly ${depth} proxy hops`, async () => {
      setEnv("API_TRUST_PROXY", depth);
      app = createApiApp({ cors: false, metricsRegistry: new Registry() });
      app.get("/proxy-proof", request => ({ ip: request.ip }));
      const response = await app.inject({ method: "GET", url: "/proxy-proof",
        remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.2" } });
      expect(response.json<{ ip: string }>().ip).toBe(expected);
    });
  }
});
