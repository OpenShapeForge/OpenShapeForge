// SPDX-License-Identifier: BUSL-1.1
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetSessionResolverForTests, resolveSessionContext } from "./identity.js";

const MANAGED_ENV = [
  "OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
  "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE",
  "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET",
] as const;

const CONTEXT_SECRET = "identity-test-context-secret";

const EMPTY = {
  tenantId: null,
  userId: null,
  roles: [] as string[],
  groups: [] as string[],
  scope: "self" as const,
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
