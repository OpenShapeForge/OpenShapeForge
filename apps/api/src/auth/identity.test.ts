// SPDX-License-Identifier: BUSL-1.1
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetSessionResolverForTests,
  mergeIdentityRoles,
  resolveSessionContext,
  SessionAuthenticationUnavailableError,
} from "./identity.js";

const MANAGED_ENV = [
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES",
  "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET",
] as const;

const CONTEXT_SECRET = "identity-test-context-secret";

const EMPTY = {
  tenantId: null,
  userId: null,
  roles: [] as string[],
  groups: [] as string[],
  scope: "self" as const,
  credential: "none" as const,
};

describe("resolveSessionContext bearer fail-closed", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED_ENV) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    __resetSessionResolverForTests();
  });

  afterEach(() => {
    for (const key of MANAGED_ENV) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetSessionResolverForTests();
  });

  test("rejects a bearer credential when no verifier is configured, even when a valid trusted-context is also present", async () => {
    // A validly HMAC-signed trusted context that WOULD authenticate on its own.
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
    __resetSessionResolverForTests();

    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { tenantId: "tenant-a", userId: "user-a", roles: ["Platform.TenantAdmin"] },
      { secret: CONTEXT_SECRET },
    );
    // Sanity: without a bearer header this exact context authenticates.
    const trustedOnly = await resolveSessionContext(new Headers(headers));
    expect(trustedOnly.tenantId).toBe("tenant-a");
    expect(trustedOnly.userId).toBe("user-a");

    // Now the caller signals bearer auth. With no verifier configured, the
    // bearer signal must fail closed and NOT downgrade to the (valid) trusted
    // context — otherwise the bearer signal would be downgrade-attackable.
    headers.set("authorization", "Bearer some.jwt.token");
    const session = await resolveSessionContext(headers);
    expect(session).toEqual(EMPTY);
  });

  test("can report an unconfigured bearer verifier without changing the default fallback", async () => {
    const headers = new Headers({ authorization: "Bearer some.jwt.token" });
    await expect(resolveSessionContext(headers)).resolves.toEqual(EMPTY);
    await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
      .rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
  });

  test("can distinguish an unavailable remote verifier from an invalid credential", async () => {
    const jwks = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", jwks.url).href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    __resetSessionResolverForTests();
    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "missing" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: "https://issuer.example.test", aud: "api" })).toString("base64url"),
      "AA",
    ].join(".");
    const headers = new Headers({ authorization: `Bearer ${token}` });
    try {
      await expect(resolveSessionContext(headers)).resolves.toEqual(EMPTY);
      await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
        .rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
    } finally {
      jwks.stop(true);
    }
  });

  test("reports a refused JWKS connection as unavailable", async () => {
    const listener = Bun.serve({ port: 0, fetch: () => new Response("unused") });
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", listener.url).href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    listener.stop(true);
    __resetSessionResolverForTests();

    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "missing" })).toString("base64url"),
      Buffer.from(JSON.stringify({
        iss: "https://issuer.example.test",
        aud: "api",
      })).toString("base64url"),
      "AA",
    ].join(".");
    const headers = new Headers({ authorization: `Bearer ${token}` });

    await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
      .rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
  });

  test("keeps a malformed bearer credential as an ordinary authentication failure", async () => {
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = "http://127.0.0.1:9/jwks";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    __resetSessionResolverForTests();

    const headers = new Headers({ authorization: "Bearer not-a-jwt" });
    await expect(resolveSessionContext(headers, { failOnUnavailable: true }))
      .resolves.toEqual(EMPTY);
  });

  test("reports unusable matching remote key material as unavailable", async () => {
    const jwks = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        keys: [{ kty: "RSA", kid: "broken", alg: "RS256", n: "bad", e: "AQAB" }],
      }),
    });
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = new URL("/jwks", jwks.url).href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    __resetSessionResolverForTests();
    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "broken" })).toString("base64url"),
      Buffer.from(JSON.stringify({
        iss: "https://issuer.example.test",
        aud: "api",
      })).toString("base64url"),
      "AA",
    ].join(".");

    try {
      await expect(resolveSessionContext(
        new Headers({ authorization: `Bearer ${token}` }),
        { failOnUnavailable: true },
      )).rejects.toBeInstanceOf(SessionAuthenticationUnavailableError);
    } finally {
      jwks.stop(true);
    }
  });

  test("non-bearer authorization schemes still fall through to trusted-context", async () => {
    // Only `Bearer` is the bearer signal. A non-bearer Authorization header
    // (e.g. Basic) must not trip the fail-closed branch.
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
    __resetSessionResolverForTests();

    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { tenantId: "tenant-a", userId: "user-a", roles: [] },
      { secret: CONTEXT_SECRET },
    );
    headers.set("authorization", "Basic dXNlcjpwYXNz");

    const session = await resolveSessionContext(headers);
    expect(session.tenantId).toBe("tenant-a");
    expect(session.userId).toBe("user-a");
  });

  test("trusted-context-only requests (no Authorization header) resolve normally", async () => {
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
    __resetSessionResolverForTests();

    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { tenantId: "tenant-b", userId: "user-b", roles: [] },
      { secret: CONTEXT_SECRET },
    );

    const session = await resolveSessionContext(headers);
    expect(session.tenantId).toBe("tenant-b");
    expect(session.userId).toBe("user-b");
  });
});

describe("mergeIdentityRoles (bearer effective roles)", () => {
  test("merges realm roles with every resource_access client's roles, deduplicated and sorted", () => {
    // Mirrors a dev-realm token: `directie` is the realm composite; Keycloak
    // expands it into entity client roles under resource_access.
    expect(
      mergeIdentityRoles({
        roles: ["directie", "default-roles-openshapeforge"],
        clientRoles: {
          "erp-provider": ["Relations.All.ReadWrite", "Relations.All.Read"],
          account: ["manage-account", "Relations.All.Read"],
        },
      }),
    ).toEqual([
      "Relations.All.Read",
      "Relations.All.ReadWrite",
      "default-roles-openshapeforge",
      "directie",
      "manage-account",
    ]);
  });

  test("returns realm roles unchanged when the token carries no client roles", () => {
    expect(mergeIdentityRoles({ roles: ["directie"] })).toEqual(["directie"]);
    expect(mergeIdentityRoles({ roles: [], clientRoles: {} })).toEqual([]);
  });
});
