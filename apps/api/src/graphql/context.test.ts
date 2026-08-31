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
 * Part 2 (real DB, scratch DB): `withDbSession` sets the `app.scope` GUC from
 *   the input scope — scope="tenant" → `app.has_scope('tenant')` is true; a
 *   session with no scope defaults to "self" and `app.has_scope('tenant')` is
 *   false. This proves the resolved scope reaches Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import type { DB } from "../generated/db/types.js";
import { createGraphqlContext } from "./context.js";
import { __resetSessionResolverForTests } from "../auth/identity.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { withDbSession } from "../db/session.js";
import { createDatabaseRuntime } from "../db/connection.js";

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
        roles: ["workflow-admin"],
        oauthScopes: ["workflow:write"],
        groups: [],
        scope: "tenant",
        credential: "bearer",
      },
    });
    expect(context.session.oauthScopes).toEqual(["workflow:write"]);
  });
});

// ── Part 2: withDbSession sets app.scope GUC (real scratch DB) ──

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;

function scratchAdminUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `context_scope_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(name);
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function readScopeState<TDatabase>(trx: import("kysely").Transaction<TDatabase>) {
  const scopeRow = await sql<{ scope: string }>`
    select current_setting('app.scope') as scope
  `.execute(trx);
  const hasRow = await sql<{ has: boolean }>`
    select app.has_scope('tenant') as has
  `.execute(trx);
  return { scope: scopeRow.rows[0]?.scope, has: hasRow.rows[0]?.has };
}

describe("withDbSession applies app.scope (F5)", () => {
  test(
    "scope=tenant sets app.scope and app.has_scope('tenant')=true; missing scope defaults to self",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), (db) =>
          db.connection().execute((conn) => runMigrationChain(conn)),
        );

        await withDb(scratchAdminUrl(name), async (db) => {
          const tenantId = randomUUID();
          const userId = randomUUID();

          // scope=tenant → GUC reflects it and app.has_scope('tenant') is true.
          const tenantResult = await withDbSession(
            db,
            { tenantId, userId, roles: [], groups: [], scope: "tenant" },
            (trx) => readScopeState(trx),
          );
          expect(tenantResult.scope).toBe("tenant");
          expect(tenantResult.has).toBe(true);

          // No scope in input → normalizeScope defaults to "self" (regression),
          // and app.has_scope('tenant') is false.
          const defaultResult = await withDbSession(
            db,
            { tenantId, userId, roles: [], groups: [] },
            (trx) => readScopeState(trx),
          );
          expect(defaultResult.scope).toBe("self");
          expect(defaultResult.has).toBe(false);
        });
      });
    },
    TEST_TIMEOUT,
  );
});
