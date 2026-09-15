// SPDX-License-Identifier: BUSL-1.1
/**
 * §F.3 — F5 fix: the runtime `scope` must thread end-to-end.
 *
 * Before the fix, `GraphqlSessionContext` had no `scope` field, so
 * `createGraphqlContext` dropped `resolved.scope`; downstream
 * `normalizeScope(undefined)` always yielded "self" and
 * `app.has_scope('tenant')` never fired.
 *
 * These tests use NO module mocking (bun's `mock.module` leaks across files in
 * one process and would pollute sibling GraphQL suites). Instead:
 *
 * Part 1 (real, unmocked): `createGraphqlContext` over a real trusted-context
 *   request threads `resolved.scope` onto `session.scope`. The trusted-context
 *   resolver yields "self", so this proves the factory copies the field through
 *   real code (before the fix the field did not exist).
 *
 * The database-backed half lives in context-db.test.ts so this file remains
 * safe for the explicitly no-database CI selection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createGraphqlContext } from "./context.js";
import { __resetSessionResolverForTests } from "../auth/identity.js";

// ── Part 1: createGraphqlContext threads resolved.scope (real path) ──

const TEST_CONTEXT_SECRET = "context-test-secret";

describe("createGraphqlContext threads resolved.scope (F5)", () => {
  const savedSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  const savedJwks = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;

  beforeAll(() => {
    // Take the signed trusted-context path (not bearer): set the shared secret,
    // clear any bearer JWKS config so getBearerVerifier() returns null. Reset
    // the identity resolver's cached verifier so the env change takes effect.
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = TEST_CONTEXT_SECRET;
    delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
    __resetSessionResolverForTests();
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = savedSecret;
    if (savedJwks === undefined) delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
    else process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = savedJwks;
    __resetSessionResolverForTests();
  });

  test("populates session.scope from the resolver (trusted-context → self)", async () => {
    const headers = new Headers();
    // A signed trusted-context request. resolveSessionContext verifies the
    // signature and falls back to readTrustedSessionContext, which resolves
    // scope to "self".
    applyTrustedContextHeaders(
      headers,
      {
        tenantId: randomUUID(),
        userId: randomUUID(),
        roles: ["Relaties.All.Read"],
        groups: [],
      },
      { secret: TEST_CONTEXT_SECRET, nowMs: Date.now() },
    );

    const context = await createGraphqlContext(headers);

    // The field exists and is threaded (before F5 it was dropped entirely).
    expect(context.session).toHaveProperty("scope");
    expect(context.session.scope).toBe("self");
    // Sanity: the signed identity actually verified (not EMPTY_IDENTITY).
    expect(context.session.tenantId).not.toBeNull();
  });

  test("preserves verified OAuth scopes for operation authorization", async () => {
    const context = await createGraphqlContext(new Headers(), {
      resolvedSession: {
        tenantId: randomUUID(),
        userId: randomUUID(),
        loginSessionBinding: "lsb1.verified-browser-session",
        roles: ["workflow-admin"],
        oauthScopes: ["workflow:write"],
        groups: [],
        relationGroupIds: ["22222222-2222-4222-8222-222222222222"],
        scope: "tenant",
        credential: "bearer",
      },
    });
    expect(context.session.oauthScopes).toEqual(["workflow:write"]);
    expect(context.session.loginSessionBinding).toBe("lsb1.verified-browser-session");
    expect(context.session.relationGroupIds).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
